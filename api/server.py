"""Bounded asynchronous spatial queries against the shared FIRMS archive."""
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from contextlib import contextmanager
import csv
from datetime import date, datetime, timedelta, timezone
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import threading
import time
from urllib.parse import urlsplit, parse_qs

from api.analysis import analyze, PLATFORMS
from api.geometry import circle_polygon, normalize_geometry

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get('SPACEAPPS_DATA_DIR', ROOT / 'data/raw/firms/global'))
CACHE = Path(os.environ.get('SPACEAPPS_ANALYSIS_CACHE', ROOT / 'data/cache/workbench'))
PRESETS = [
    {'id': 'sko', 'name': 'Северо-Казахстанская область', 'bbox': [65.9, 52.2, 74.3, 55.5], 'polygon': True},
    {'id': 'california', 'name': 'Калифорния · окно исследования', 'bbox': [-124.5, 32.5, -114, 42]},
    {'id': 'brazil', 'name': 'Мату-Гросу · окно исследования', 'bbox': [-61.5, -18, -50, -7]},
    {'id': 'canada', 'name': 'Альберта · окно исследования', 'bbox': [-120, 49, -110, 60]},
]
WORLD_BOUNDS = [-180, -85, 180, 85]
JOBS = {}
JOBS_LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=1)
MATRIX_POOL=ThreadPoolExecutor(max_workers=1)
MATRIX_JOBS={}
CACHE.mkdir(parents=True, exist_ok=True)
MAP_LIMIT=threading.BoundedSemaphore(1)
GEOMETRY_LIMIT=threading.BoundedSemaphore(1)
ACTIVE_EXTRACTS=Counter()
EXTRACT_VERSION='nasa-spatial-v2'
ANALYSIS_VERSION='nasa-temporal-v4'


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.json.part')
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False))
    temporary.replace(path)


def connection(temp=None,memory='640MB'):
    import duckdb
    con = duckdb.connect(config={'threads':1,'memory_limit':memory})
    con.execute('SET enable_progress_bar=false')
    if extension := os.environ.get('DUCKDB_EXTENSION_DIRECTORY'):
        con.execute('SET extension_directory=?', [extension])
    con.execute('LOAD spatial')
    con.execute('SET geometry_always_xy=true')
    if temp:
        temp.mkdir(parents=True, exist_ok=True)
        con.execute('SET temp_directory=?', [str(temp)])
        con.execute("SET max_temp_directory_size='4GB'")
    return con


def region_geometry():
    value = json.loads((ROOT / 'data/boundaries/north-kazakhstan.geojson').read_text())
    if value['type'] == 'FeatureCollection':
        return value['features'][0]['geometry']
    return value.get('geometry', value)


def region_bounds():
    def pairs(node):
        if isinstance(node[0],(int,float)):
            yield node
        else:
            for item in node:
                yield from pairs(item)
    points=list(pairs(region_geometry()['coordinates']))
    return [min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]


def validate(value):
    if not isinstance(value, dict):
        raise ValueError('Ожидается объект параметров анализа.')
    geometry=None
    preset = value.get('preset', 'custom')
    if preset == 'world':
        bbox = WORLD_BOUNDS
    elif preset != 'sko' and (value.get('geometry') is not None or value.get('circle') is not None):
        with GEOMETRY_LIMIT:
            geometry,bbox=normalize_geometry(circle_polygon(value['circle']) if value.get('circle') is not None else value['geometry'],connection)
    else:bbox = value.get('bbox')
    if not isinstance(bbox, list) or len(bbox) != 4 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in bbox):
        raise ValueError('Укажите четыре конечные координаты: запад, юг, восток, север.')
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
        raise ValueError('Границы: долгота −180…180, широта −85…85; запад < восток, юг < север.')
    if preset != 'world' and geometry is None and (east - west) * (north - south) > 5000:
        raise ValueError('Для детального анализа выделите область меньше 5000 квадратных градусов.')
    start, end = date.fromisoformat(value['start']), date.fromisoformat(value['end'])
    if not date(2000, 11, 1) <= start <= end <= date.today():
        raise ValueError('Выберите период от 1 ноября 2000 года до сегодняшней даты.')
    def integer(name, default=None):
        raw=value.get(name,default)
        if isinstance(raw,bool) or isinstance(raw,float) and (not math.isfinite(raw) or not raw.is_integer()):
            raise ValueError(f'{name}: требуется целое число.')
        return int(raw)
    a, b = integer('baseline_start'), integer('baseline_end')
    if not start.year <= a <= b <= end.year:
        raise ValueError('Годы базового периода должны находиться внутри выбранной истории.')
    grid = 250 if preset == 'world' else integer('grid_km',10)
    if preset != 'world' and grid not in (2, 5, 10, 20):
        raise ValueError('Размер сетки: 2, 5, 10 или 20 км.')
    quality = value.get('quality', 'sp')
    daytime = value.get('daynight', 'all')
    if quality not in ('sp', 'all') or daytime not in ('all', 'D', 'N'):
        raise ValueError('Неверный фильтр качества или времени суток.')
    if preset not in ('custom', 'world') and preset not in {p['id'] for p in PRESETS}:
        raise ValueError('Неизвестная область.')
    if preset=='sko':
        bbox=region_bounds()
    result={'bbox': [round(x, 5) for x in bbox] if geometry is None else bbox, 'preset': preset,
            'start': start.isoformat(), 'end': end.isoformat(), 'baseline_start': a, 'baseline_end': b,
            'grid_km': grid, 'quality': quality, 'daynight': daytime}
    if geometry is not None:result['geometry']=geometry
    for field,limit in [('roi_name',120),('roi_source',200)]:
        if value.get(field) is not None:
            if not isinstance(value[field],str) or len(value[field])>limit:raise ValueError(f'Слишком длинное поле {field}.')
            result[field]=value[field]
    if geometry is not None and value.get('circle') is not None:result['circle']=value['circle']
    return result


def query_geometry(config):
    if config['preset']=='sko':return region_geometry()
    if config.get('geometry'):return config['geometry']
    w,s,e,n=config['bbox']
    return {'type':'Polygon','coordinates':[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}


@contextmanager
def pinned_sources(config):
    """Hold source inodes via fds, releasing the sync lock before scanning.

    This prevents a refresh from changing a long-running query's snapshot without
    copying the archive into the API cache. /proc/self/fd is local to this process.
    """
    handles = []
    try:
        with (DATA / '.sync.lock').open('r') as lock:
            deadline=time.monotonic()+120
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic()>=deadline:
                        raise ValueError('Архив обновляется. Повторите запрос через несколько минут.')
                    time.sleep(.5)
            state = json.loads((DATA / 'manifest.json').read_text())
            if state['status'] != 'ready':
                raise ValueError('Архив обновляется. Повторите запрос после завершения синхронизации.')
            sources = []
            for asset in state['assets'].values():
                if asset['kind'] == 'observations' and int(config['start'][:4]) <= asset['year'] <= int(config['end'][:4]):
                    h = (DATA / asset['path']).open('rb'); handles.append(h)
                    sources.append({**asset, 'fd': f'/proc/self/fd/{h.fileno()}'})
            tail = state.get('live_tail')
            if tail and tail.get('rows') and tail.get('base_sha256') == state['assets'].get(f"observations/year={tail['end'][:4]}/detections.parquet", {}).get('sha256'):
                year = int(tail['end'][:4])
                if int(config['start'][:4]) <= year <= int(config['end'][:4]):
                    h = (DATA / tail['path']).open('rb'); handles.append(h)
                    sources.append({**tail, 'year': year, 'fd': f'/proc/self/fd/{h.fileno()}'})
        yield state, sources
    finally:
        for h in handles:
            h.close()


def outages():
    result = set()
    with (ROOT / 'docs/sko-validation/outages.csv').open() as stream:
        for row in csv.DictReader(stream):
            day, end = date.fromisoformat(row['start_utc']), date.fromisoformat(row['end_utc_inclusive'])
            while day <= end:
                result.add((day.isoformat(), row['platform']))
                day += timedelta(days=1)
    return result


def archive_through(state):
    dates=[s.get('end') for s in state.get('assets',{}).values() if s.get('kind')=='observations' and s.get('end')]
    if (state.get('live_tail') or {}).get('end'):
        dates.append(state['live_tail']['end'])
    return max(dates) if dates else None


def ensure_space():
    minimum=2*1024**3
    budget=10*1024**3
    if shutil.disk_usage(CACHE).free<minimum:
        raise ValueError('Недостаточно места в кэше анализа. Повторите запрос после очистки кэша.')
    total=sum(p.stat().st_size for p in CACHE.rglob('*') if p.is_file() and not p.is_symlink())
    if total<budget:
        return
    candidates=sorted((p for p in (CACHE/'extracts').glob('*') if p.is_dir() and re.fullmatch(r'[0-9a-f]{32}',p.name)),key=lambda p:p.stat().st_mtime)
    for folder in candidates:
        with JOBS_LOCK:
            if folder.name in ACTIVE_EXTRACTS:
                continue
            size=sum(p.stat().st_size for p in folder.rglob('*') if p.is_file() and not p.is_symlink())
            shutil.rmtree(folder)
        total-=size
        if total<budget*.8:
            break
    jobs=sorted((CACHE/'jobs').glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)
    for saved in jobs[128:]:
        with JOBS_LOCK:
            if saved.stem not in JOBS:
                saved.unlink(missing_ok=True)
    if total>=budget or shutil.disk_usage(CACHE).free<minimum:
        raise ValueError('Кэш анализа занят. Повторите запрос позже.')


def set_progress(job, **fields):
    with JOBS_LOCK:
        JOBS[job].update(fields)


def extract(job, config, sources, key):
    folder = CACHE / 'extracts' / key
    summary = folder / 'daily.json'
    if summary.exists():
        set_progress(job, progress=95, message='Использую сохранённый пространственный запрос')
        return json.loads(summary.read_text())
    folder.mkdir(parents=True, exist_ok=True)
    atomic_json(folder/'grid.json',{'grid_km':config['grid_km'],'config':config})
    con = connection(folder / 'temporary')
    daily, availability = [], []
    try:
        con.execute('CREATE TEMP TABLE excluded(day DATE,platform VARCHAR)')
        con.executemany('INSERT INTO excluded VALUES (?,?)',sorted(outages()))
        grouped = {}
        for source in sources:
            grouped.setdefault(source['year'], []).append(source)
        for index, (year, assets) in enumerate(sorted(grouped.items())):
            ensure_space()
            set_progress(job, progress=round(90 * index / max(1, len(grouped))), message=f'Обрабатываю {year} год', year=year)
            paths = [a['fd'] for a in assets]
            fingerprint = hashlib.sha256(''.join(a['sha256'] for a in assets).encode()).hexdigest()
            global_path = CACHE / 'availability' / (fingerprint + '.json')
            if global_path.exists():
                available = json.loads(global_path.read_text())
            else:
                rows = con.execute("""SELECT acq_datetime::DATE,satellite,bool_or(lower(quality)='sp')
                    FROM read_parquet(?,hive_partitioning=false,union_by_name=true) GROUP BY 1,2""", [paths]).fetchall()
                available = [{'date': str(day), 'platform': platform, 'sp': standard} for day, platform, standard in rows]
                atomic_json(global_path, available)
            availability.extend(available)
            world = config['preset'] == 'world'
            spatial = 'AND ST_Y(geometry) BETWEEN -85 AND 85' if world else 'AND ST_Intersects(geometry,ST_GeomFromGeoJSON(?))'
            quality = "AND lower(quality)='sp' AND type=0" if config['quality'] == 'sp' else 'AND (type=0 OR type IS NULL)'
            daytime = '' if config['daynight'] == 'all' else 'AND daynight=?'
            params = [config['grid_km'] * 1000, config['grid_km'] * 1000, paths, config['start'], config['end']]
            if not world:
                params.append(json.dumps(query_geometry(config)))
            if daytime:
                params.append(config['daynight'])
            con.execute(f"""CREATE OR REPLACE TEMP TABLE selected AS WITH pixels AS (
                SELECT acq_datetime::DATE AS day,satellite AS platform,quality,
                  floor(ST_X(ST_Transform(geometry,'EPSG:6933'))/?)::INTEGER AS gx,
                  floor(ST_Y(ST_Transform(geometry,'EPSG:6933'))/?)::INTEGER AS gy
                FROM read_parquet(?,hive_partitioning=false,union_by_name=true)
                WHERE acq_datetime >= ?::DATE AND acq_datetime < ?::DATE + INTERVAL 1 DAY
                  {spatial}
                  AND NOT EXISTS(SELECT 1 FROM excluded e WHERE e.day=acq_datetime::DATE AND e.platform=satellite)
                  AND ((instrument='MODIS' AND confidence_pct>=30) OR
                       (instrument='VIIRS' AND lower(confidence) IN ('n','h','nominal','high')))
                  {quality} {daytime}
                )
                SELECT day,platform,gx,gy,count(*) AS points,bool_or(lower(quality)='sp') AS sp,
                       count(*) FILTER(WHERE lower(quality)<>'sp') AS nrt
                FROM pixels GROUP BY 1,2,3,4""", params)
            rows = con.execute("""SELECT day,platform,sum(points),count(*),
                   count(*) FILTER(WHERE sp),sum(nrt) FROM selected GROUP BY 1,2 ORDER BY 1,2""").fetchall()
            daily.extend({'date': str(day), 'platform': platform, 'points': points, 'cells': cells,
                          'sp_cells': sp, 'nrt_points': nrt} for day, platform, points, cells, sp, nrt in rows)
            map_path = folder / f'{year}.parquet'
            temporary = map_path.with_suffix('.parquet.part')
            con.execute("""COPY (SELECT day,strftime(day,'%Y-%m') AS month,platform,gx,gy,
                     1 AS days,points
                     FROM selected) TO ? (FORMAT PARQUET,COMPRESSION ZSTD)""", [str(temporary)])
            temporary.replace(map_path)
            con.execute('DROP TABLE selected')
        result = {'daily': daily, 'availability': availability}
        atomic_json(summary, result)
        return result
    finally:
        con.close()


def run(job, config):
    fingerprint=None
    try:
        ensure_space()
        set_progress(job, status='running', message='Фиксирую снимок архива', progress=0)
        with pinned_sources(config) as (state, sources):
            if not sources:
                raise ValueError('В выбранном периоде нет доступных файлов архива.')
            spatial = {k:v for k,v in config.items() if not k.startswith('baseline_')}
            geometry=json.dumps(config['geometry'],sort_keys=True) if config.get('geometry') else (json.dumps(region_geometry(),sort_keys=True) if config['preset']=='sko' else json.dumps(config['bbox']))
            geometry_sha=hashlib.sha256(geometry.encode()).hexdigest()
            outages_sha=hashlib.sha256((ROOT/'docs/sko-validation/outages.csv').read_bytes()).hexdigest()
            fingerprint = hashlib.sha256(json.dumps({'config': spatial, 'sources': [a['sha256'] for a in sources],
                'geometry_sha':geometry_sha,'outages_sha':outages_sha,'extract_version':EXTRACT_VERSION}, sort_keys=True).encode()).hexdigest()[:32]
            with JOBS_LOCK:
                ACTIVE_EXTRACTS[fingerprint]+=1
            values = extract(job, config, sources, fingerprint)
            set_progress(job, progress=96, message='Считаю сезонность и проверяю калибровку')
            excluded = outages()
            through=archive_through(state)
            scoped={**config,'incomplete_utc_dates':[through[:10]] if through else []}
            atomic_json(CACHE/'extracts'/fingerprint/'grid.json',{'grid_km':config['grid_km'],'config':config,'through':through})
            result = analyze(values['daily'], values['availability'], scoped, excluded)
            result.update(config=config, extract_id=fingerprint,
                through=through,last_complete_day=str(date.fromisoformat(through[:10])-timedelta(days=1)) if through else None,
                snapshot_at=state['updated_at'], daily=values['daily'],
                availability=[r for r in values['availability'] if config['start']<=r['date']<=config['end'] and (r['date'],r['platform']) not in excluded],
                calculated_at=datetime.now(timezone.utc).isoformat(),analysis_version=ANALYSIS_VERSION,
                provenance={'producer': state['producer'], 'mirror': state['mirror'],
                    'sources': [{'path':s['path'],'sha256':s['sha256'],'start':s.get('start'),'end':s.get('end')} for s in sources],
                    'confidence_filter': 'MODIS confidence_pct>=30; VIIRS nominal/high',
                    'fire_type': 'type=0; NULL type retained only when NRT enabled',
                    'outage_dates': len(excluded), 'outage_list': 'docs/sko-validation/outages.csv',
                    'grid_crs': 'EPSG:6933', 'local_observation_coverage': 'unknown'})
            result['provenance'].update(extract_version=EXTRACT_VERSION,geometry_sha256=geometry_sha,outages_sha256=outages_sha,
                incomplete_utc_dates=scoped['incomplete_utc_dates'],week_basis='ISO year/week; profiles require 7 globally available dates')
            atomic_json(CACHE / 'jobs' / (job + '.json'), result)
            set_progress(job, status='done', progress=100, message='Анализ готов', result=result)
    except Exception as error:
        print(f'Analysis {job} failed: {type(error).__name__}: {error}', flush=True)
        set_progress(job, status='error', message='Не удалось завершить запрос. ' + str(error)[:250], progress=0)
    finally:
        if fingerprint:
            with JOBS_LOCK:
                ACTIVE_EXTRACTS[fingerprint]-=1
                if ACTIVE_EXTRACTS[fingerprint]<=0:
                    ACTIVE_EXTRACTS.pop(fingerprint,None)


class BusyMapError(Exception):
    pass


@contextmanager
def map_guard(extract_id):
    if not re.fullmatch(r'[0-9a-f]{32}',extract_id):
        raise ValueError('Неверный идентификатор пространственного запроса.')
    if not MAP_LIMIT.acquire(blocking=False):
        raise BusyMapError('Карта занята другим запросом. Повторите через несколько секунд.')
    with JOBS_LOCK:
        ACTIVE_EXTRACTS[extract_id]+=1
    try:
        yield
    finally:
        with JOBS_LOCK:
            ACTIVE_EXTRACTS[extract_id]-=1
            if ACTIVE_EXTRACTS[extract_id]<=0:
                ACTIVE_EXTRACTS.pop(extract_id,None)
        MAP_LIMIT.release()


def polygons(con,cells,grid,factor):
    if not cells:
        return []
    records=[{'x':float(row[0]),'y':float(row[1]),'i':i} for i,row in enumerate(cells)]
    step=grid*1000
    bounds=con.execute("""SELECT ST_X(a),ST_Y(a),ST_X(b),ST_Y(b),i FROM (
        SELECT i,ST_Transform(ST_Point(x*?,y*?)::GEOMETRY('EPSG:6933'),'OGC:CRS84') a,
        ST_Transform(ST_Point((x+?)*?,(y+?)*?)::GEOMETRY('EPSG:6933'),'OGC:CRS84') b
        FROM (SELECT unnest.x x,unnest.y y,unnest.i i
              FROM unnest(?::STRUCT(x DOUBLE,y DOUBLE,i INTEGER)[])))""",
        [step,step,factor,step,factor,step,records]).fetchall()
    return [tuple(list(row[:4])+list(cells[row[4]][2:])) for row in bounds]


def cached_grid(extract_id):
    folder=CACHE/'extracts'/extract_id
    if not (folder/'daily.json').exists() or not (folder/'grid.json').exists():
        raise ValueError('Пространственный кэш недоступен. Повторите анализ выбранной области.')
    os.utime(folder,None)
    return folder,json.loads((folder/'grid.json').read_text())


def map_cells(extract_id,month,platform,day=None,start=None,end=None):
    with map_guard(extract_id):
        if not re.fullmatch(r'\d{4}(?:-(?:0[1-9]|1[0-2]))?',month) or platform not in PLATFORMS:
            raise ValueError('Неверные параметры карты.')
        folder,metadata=cached_grid(extract_id)
        annual=len(month)==4
        if annual:
            first=date.fromisocalendar(int(month),1,1)
            last=date.fromisocalendar(int(month)+1,1,1)-timedelta(days=1)
        else:
            first=date.fromisoformat(month+'-01')
            last=(first.replace(day=28)+timedelta(days=4)).replace(day=1)-timedelta(days=1)
        if day:
            first=last=date.fromisoformat(day)
            if not day.startswith(month+'-'):
                raise ValueError('Дата должна принадлежать выбранному месяцу.')
        cfg=metadata.get('config',{})
        custom=start is not None or end is not None
        if custom:
            if day or not start or not end:raise ValueError('Диапазон карты: укажите start и end, без day.')
            first,last=date.fromisoformat(start),date.fromisoformat(end)
            if first>last:raise ValueError('Начало диапазона позже окончания.')
            if start<cfg.get('start',start) or end>cfg.get('end',end):raise ValueError('Период карты вне рассчитанной истории. Расширьте историю анализа.')
        first=max(first,date.fromisoformat(cfg.get('start',first.isoformat())))
        last=min(last,date.fromisoformat(cfg.get('end',last.isoformat())))
        paths=[str(p) for year in range(first.year,last.year+1) if (p:=folder/f'{year}.parquet').exists()]
        if not paths:
            return {'cells':[],'grid_km':metadata['grid_km'],'display_grid_km':metadata['grid_km'],'month':month,'platform':platform,'year_basis':'UTC-range' if custom else 'ISO' if annual else 'calendar','start_date':first.isoformat(),'end_date':last.isoformat()}
        con=connection(CACHE/'map-temporary',memory='192MB')
        try:
            factor=1
            while True:
                cells=con.execute("""SELECT floor(gx/?)*? x,floor(gy/?)*? y,sum(days)::BIGINT,sum(points)::BIGINT
                    FROM read_parquet(?) WHERE day BETWEEN ?::DATE AND ?::DATE AND platform=? GROUP BY 1,2""",
                    [factor,factor,factor,factor,paths,first.isoformat(),last.isoformat(),platform]).fetchall()
                if len(cells)<=5000 or factor>=128:
                    break
                factor*=2
            return {'cells':polygons(con,cells,metadata['grid_km'],factor),'grid_km':metadata['grid_km'],
                'display_grid_km':metadata['grid_km']*factor,'month':month,'platform':platform,
                'metric':'sum of original-grid cell-days','year_basis':'UTC-range' if custom else 'ISO' if annual else 'calendar',
                'start_date':first.isoformat(),'end_date':last.isoformat()}
        finally:
            con.close()


def anomaly_map(extract_id,month,platform,baseline_start,baseline_end):
    with map_guard(extract_id):
        if not re.fullmatch(r'\d{4}-(?:0[1-9]|1[0-2])',month) or platform not in PLATFORMS:
            raise ValueError('Неверные параметры карты отклонений.')
        folder,metadata=cached_grid(extract_id)
        cfg={**metadata['config'],'baseline_start':int(baseline_start),'baseline_end':int(baseline_end)}
        cfg=validate(cfg)
        through=metadata.get('through')
        scoped={**cfg,'incomplete_utc_dates':[through[:10]] if through else []}
        key=f'anomaly-{month}-{platform}-{cfg["baseline_start"]}-{cfg["baseline_end"]}.json'
        if (folder/key).exists():
            return json.loads((folder/key).read_text())
        daily=json.loads((folder/'daily.json').read_text())
        stats=analyze(daily['daily'],daily['availability'],scoped,outages())
        row=next((r for r in stats['monthly'] if r['month']==month and r['platform']==platform),None)
        response={'cells':[],'grid_km':metadata['grid_km'],'display_grid_km':metadata['grid_km'],
            'month':month,'platform':platform,'baseline_years':row['baseline_years'] if row else 0,
            'local_coverage':'unknown','status':'insufficient_baseline','message':'Недостаточно сопоставимых базовых наблюдений.'}
        if row is None or row['comparison_status']!='ok':
            if row and row['comparison_status']=='incomplete_utc_day':
                response['message']='Последние сутки архива неполные; сравнение с полными историческими сутками отключено.'
            elif row and row['comparison_status']=='insufficient_target_days':
                response['message']='Недостаточно доступных дат выбранного периода для сравнения.'
            return response
        years=[*row['baseline_year_ids'],int(month[:4])]
        paths=[str(p) for year in years if (p:=folder/f'{year}.parquet').exists()]
        if not paths:
            return response
        con=connection(CACHE/'map-temporary',memory='192MB')
        try:
            factor=1
            while True:
                cells=con.execute("""SELECT year(day)::INTEGER y,floor(gx/?)*? x,floor(gy/?)*? yy,sum(days)::BIGINT
                  FROM read_parquet(?) WHERE platform=? AND month(day)=?
                    AND day(day) IN (SELECT unnest(?::INTEGER[])) GROUP BY 1,2,3""",
                    [factor,factor,factor,factor,paths,platform,int(month[5:]),row['comparison_day_numbers']]).fetchall()
                coordinates={(r[1],r[2]) for r in cells}
                if len(coordinates)<=5000 or factor>=128:
                    break
                factor*=2
            lookup={(year,x,y):count for year,x,y,count in cells}
            import statistics
            output=[]
            for x,y in sorted(coordinates):
                current=lookup.get((int(month[:4]),x,y),0)
                reference=statistics.median(lookup.get((year,x,y),0) for year in row['baseline_year_ids'])
                delta=100*(current/reference-1) if reference>0 else None
                output.append((x,y,current,reference,delta,row['baseline_years']))
            response.update(cells=polygons(con,output,metadata['grid_km'],factor),status='ok',
                display_grid_km=metadata['grid_km']*factor,
                message='Отклонения записанных ячейко-дней; локальная видимость неизвестна.',
                comparison_day_numbers=row['comparison_day_numbers'],baseline_year_ids=row['baseline_year_ids'])
            atomic_json(folder/key,response)
            return response
        finally:
            con.close()


def run_matrix(identifier,analysis_id,analysis):
    def progress(**values):
        with JOBS_LOCK:MATRIX_JOBS[identifier].update(values)
    try:
        from api.matrix import build
        ensure_space();progress(status='running',message='Подготавливаю численную выборку территории',progress=1)
        result=build(analysis,analysis_id,progress)
        atomic_json(CACHE/'matrix'/'jobs'/(identifier+'.json'),result)
        progress(status='done',progress=100,message='Матрица готова',result=result)
    except Exception as error:
        print(f'Matrix {identifier} failed: {type(error).__name__}: {error}',flush=True)
        progress(status='error',progress=0,message='Матрица не рассчитана. '+str(error)[:240])


def job_status(info, compact=False):
    if not compact or info['status'] != 'done':
        return info
    result = info['result']
    keys = ('config', 'extract_id', 'snapshot_at', 'monthly')
    return {**info, 'result': {key: result[key] for key in keys}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def respond(self, status, value, content_type='application/json; charset=utf-8', filename=None):
        content = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() if isinstance(value, (dict,list)) else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if filename:
            self.send_header('Content-Disposition', 'attachment; filename="'+filename+'"')
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        try:
            if match:=re.fullmatch(r'/api/v1/analyses/([0-9a-f]{32})/matrix',self.path):
                size=int(self.headers.get('Content-Length',0))
                if not 0<=size<=1024:return self.respond(413,{'error':'Матрица использует параметры готового анализа.'})
                if size:
                    options=json.loads(self.rfile.read(size))
                    if options!={}:return self.respond(400,{'error':'Матрица использует параметры готового анализа; передайте {}.'})
                analysis_id=match[1]
                with JOBS_LOCK:info=JOBS.get(analysis_id)
                if info and info['status']!='done':return self.respond(409,{'error':'Сначала дождитесь готовности анализа.'})
                saved=CACHE/'jobs'/(analysis_id+'.json')
                analysis=info['result'] if info else json.loads(saved.read_text()) if saved.exists() else None
                if analysis is None:return self.respond(404,{'error':'Исходный анализ не найден.'})
                if analysis.get('analysis_version')!=ANALYSIS_VERSION:return self.respond(409,{'error':'Методика обновлена. Сначала пересчитайте анализ.'})
                identifier=hashlib.sha256((analysis_id+str(time.time_ns())).encode()).hexdigest()[:32]
                with JOBS_LOCK:
                    if sum(j['status'] in ('queued','running') for j in MATRIX_JOBS.values())>=3:return self.respond(429,{'error':'Очередь матриц занята. Повторите позже.'})
                    if len(MATRIX_JOBS)>16:
                        for old in [k for k,v in MATRIX_JOBS.items() if v['status'] in ('done','error')][:8]:MATRIX_JOBS.pop(old,None)
                    MATRIX_JOBS[identifier]={'id':identifier,'status':'queued','progress':0,'message':'Матрица в очереди'}
                MATRIX_POOL.submit(run_matrix,identifier,analysis_id,analysis)
                return self.respond(202,{'id':identifier,'status':'queued'})
            if self.path != '/api/v1/analyses':
                return self.respond(404, {'error':'Неизвестный адрес API.'})
            size = int(self.headers.get('Content-Length',0))
            if not 0 < size <= 524288:
                return self.respond(413, {'error':'Слишком большой или пустой запрос.'})
            config = validate(json.loads(self.rfile.read(size)))
            job = hashlib.sha256((json.dumps(config,sort_keys=True)+str(time.time_ns())).encode()).hexdigest()[:32]
            with JOBS_LOCK:
                if sum(j['status'] in ('queued','running') for j in JOBS.values()) >= 8:
                    return self.respond(429, {'error':'Очередь заполнена. Повторите запрос позже.'})
                if len(JOBS)>32:
                    for old in [key for key,value in JOBS.items() if value['status'] in ('done','error')][:16]:
                        JOBS.pop(old,None)
                JOBS[job] = {'id':job, 'status':'queued', 'progress':0, 'message':'Запрос в очереди'}
            POOL.submit(run,job,config)
            return self.respond(202, {'id':job, 'status':'queued'})
        except (ValueError,TypeError,KeyError,OverflowError) as error:
            return self.respond(400, {'error':str(error)[:200]})

    def do_GET(self):
        parsed = urlsplit(self.path)
        try:
            if parsed.path == '/api/v1/world-calendar':
                saved = CACHE / 'world-calendar' / 'published.json'
                try:
                    with saved.open('rb') as stream:
                        return self.respond(200, stream.read())
                except FileNotFoundError:
                    seed = ROOT / 'web/data/world-calendar.json'
                    return self.respond(200, seed.read_bytes()) if seed.is_file() else self.respond(202, {'status': 'preparing'})
            if parsed.path == '/api/v1/health':
                return self.respond(200, {'status':'ok','data_available':(DATA/'manifest.json').exists()})
            if parsed.path == '/api/v1/config':
                state = json.loads((DATA/'catalog.json').read_text())
                return self.respond(200, {'presets':[{**p,'bbox':region_bounds()} if p['id']=='sko' else p for p in PRESETS], 'platforms':PLATFORMS,
                    'start':'2000-11-01', 'end':date.today().isoformat(), 'rows':state['base_rows'],
                    'through':max([a.get('end','') for a in state['assets'] if a['kind']=='observations']+[(state.get('live_tail') or {}).get('end') or '']),
                    'snapshot_at':state['updated_at'], 'region_geometry':region_geometry()})
            if match:=re.fullmatch(r'/api/v1/matrices/([0-9a-f]{32})(/export)?',parsed.path):
                identifier,export=match.groups()
                with JOBS_LOCK:info=dict(MATRIX_JOBS[identifier]) if identifier in MATRIX_JOBS else None
                saved=CACHE/'matrix'/'jobs'/(identifier+'.json')
                if info is None and saved.exists():info={'id':identifier,'status':'done','progress':100,'message':'Матрица готова','result':json.loads(saved.read_text())}
                if info is None:return self.respond(404,{'error':'Матрица не найдена.'})
                from api.matrix import VERSION
                if info['status']=='done' and info['result'].get('version')!=VERSION:return self.respond(409,{'error':'Методика матрицы обновлена; пересчитайте её.'})
                if not export:return self.respond(200,info)
                if info['status']!='done':return self.respond(409,{'error':'Дождитесь готовности матрицы.'})
                result=info['result']
                if parse_qs(parsed.query).get('format',['csv'])[0]=='json':return self.respond(200,json.dumps(result,ensure_ascii=False,indent=2).encode(),'application/json; charset=utf-8','nasa-space-apps-matrix.json')
                stream=io.StringIO(newline='');writer=csv.writer(stream);writer.writerow(['platform','mode','factor_a','factor_b','rho','n','reason','n_overlap','n_used','strata_used','mask_sha256','roi','start','end','quality','extract_id'])
                for platform,modes in result['results'].items():
                    for mode,values in modes.items():
                        factors=result['space_factors'] if mode=='space' else result['time_factors']
                        for i,row in enumerate(values):
                            for j,(rho,n) in enumerate(row):
                                detail=result['pair_details'][platform][mode][i][j]
                                writer.writerow([platform,mode,factors[i]['id'],factors[j]['id'],rho,n,detail['reason'],detail['n_overlap'],detail['n_used'],detail['strata_used'],detail['mask_sha256'],result['config'].get('roi_name',result['config']['preset']),result['config']['start'],result['config']['end'],result['config']['quality'],result['extract_id']])
                return self.respond(200,('\ufeff'+stream.getvalue()).encode(),'text/csv; charset=utf-8','nasa-space-apps-matrix.csv')
            if match := re.fullmatch(r'/api/v1/analyses/([0-9a-f]{32})(/export)?',parsed.path):
                job, export = match.groups()
                with JOBS_LOCK:
                    info = dict(JOBS[job]) if job in JOBS else None
                saved = CACHE/'jobs'/(job+'.json')
                if info is None and saved.exists():
                    info = {'id':job,'status':'done','progress':100,'message':'Анализ готов','result':json.loads(saved.read_text())}
                if info is None:
                    return self.respond(404, {'error':'Запрос не найден.'})
                if info['status']=='done' and info['result'].get('analysis_version')!=ANALYSIS_VERSION:
                    return self.respond(409,{'error':'Методика анализа обновлена. Постройте анализ заново с теми же параметрами.'})
                if export:
                    if info['status'] != 'done':
                        return self.respond(409,{'error':'Дождитесь завершения анализа.'})
                    result=info['result']
                    if parse_qs(parsed.query).get('format',['csv'])[0]=='json':
                        return self.respond(200,json.dumps(result,ensure_ascii=False,indent=2).encode(),'application/json; charset=utf-8','nasa-space-apps-analysis.json')
                    stream=io.StringIO(newline='');columns=['month','platform','cells','points','eligible_days','calendar_days','partial','nrt_points','preliminary_days','calibration_eligible','baseline_calibration_eligible','comparison_status','baseline','baseline_equivalent','baseline_years','anomaly_pct','percentile','local_coverage']
                    writer=csv.DictWriter(stream,fieldnames=columns+['grid_km','quality_scope','aqua_equivalent','model_valid'],extrasaction='ignore');writer.writeheader()
                    for row in result['monthly']:
                        model=result['models'].get(row['platform'],{})
                        writer.writerow({**row,'grid_km':result['config']['grid_km'],'quality_scope':result['config']['quality'],
                          'aqua_equivalent':row['aqua_equivalent'], 'model_valid':row['model_valid']})
                    return self.respond(200,('\ufeff'+stream.getvalue()).encode(),'text/csv; charset=utf-8','nasa-space-apps-monthly.csv')
                return self.respond(200, job_status(info, parse_qs(parsed.query).get('view') == ['calendar']))
            if match := re.fullmatch(r'/api/v1/maps/([0-9a-f]{32})',parsed.path):
                query=parse_qs(parsed.query)
                return self.respond(200,map_cells(match[1],query.get('month',[''])[0],query.get('platform',[''])[0],query.get('day',[None])[0],query.get('start',[None])[0],query.get('end',[None])[0]))
            if match := re.fullmatch(r'/api/v1/anomaly-map/([0-9a-f]{32})',parsed.path):
                query=parse_qs(parsed.query)
                return self.respond(200,anomaly_map(match[1],query.get('month',[''])[0],query.get('platform',[''])[0],
                    query.get('baseline_start',['0'])[0],query.get('baseline_end',['0'])[0]))
            return self.respond(404,{'error':'Неизвестный адрес API.'})
        except BusyMapError as error:
            return self.respond(429,{'error':str(error)})
        except (ValueError,KeyError,TypeError) as error:
            return self.respond(400,{'error':str(error)[:200]})
        except Exception as error:
            print(type(error).__name__,str(error),flush=True)
            return self.respond(503,{'error':'Архив временно недоступен. Повторите запрос.'})

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


if __name__ == '__main__':
    from api.world_calendar import run as refresh_world_calendar
    threading.Thread(target=refresh_world_calendar, args=(DATA, CACHE, pinned_sources, atomic_json), daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0',8081),Handler).serve_forever()
