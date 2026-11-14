"""On-demand global, numerical fire/weather/landscape matrices.

No regional precomputed matrix is used here. Satellite inputs are immutable
analysis extracts; external numerical assets are cached with their digests.
"""
from collections import defaultdict
from datetime import date,datetime,timedelta,timezone
import hashlib
import io
import json
import math
from pathlib import Path
import statistics
import time
from contextlib import ExitStack
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request,urlopen
from zipfile import ZipFile

from api.analysis import PLATFORMS,days_between,quantile

VERSION='global-factors-v2'
FIELDS=['temperature_2m_max','wind_speed_10m_mean','precipitation_sum','relative_humidity_2m_mean','soil_moisture_0_to_7cm_mean','cloud_cover_mean']
UNITS=['°C','m/s','mm','%','m³/m³','%']
TIME_FACTORS=[('fire','Обнаруженная активность','Активность','ячейко-дни'),('temperature','Температура, суточный максимум','Температура','°C'),('wind','Ветер, средняя скорость','Ветер','м/с'),('rain','Осадки за сутки','Осадки','мм'),('rain7','Осадки за предыдущие 7 суток','Осадки 7 дн.','мм'),('humidity','Относительная влажность воздуха','Влажность','%'),('soil','Влажность почвы 0–7 см','Почва','м³/м³'),('cloud','Средняя облачность','Облачность','%')]
SPACE_FACTORS=[('fire','Плотность обнаруженной активности','Активность','ячейко-дни/км²/день продукта'),('city','Расстояние до города GeoNames cities5000','До города','км'),('elevation','Медиана высоты по точкам GLO-90','Высота','м'),('relief','Разброс высот по точкам (p90–p10)','Перепад','м'),('forest','Лес, доля точек WorldCover 2021','Лес','% точек'),('grass','Травяной покров, доля точек 2021','Трава','% точек'),('crop','Пашня, доля точек 2021','Пашня','% точек'),('wetland','Заболоченная растительность, доля точек 2021','Болота','% точек')]


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def finite(value):
    return not isinstance(value,bool) and isinstance(value,(int,float)) and math.isfinite(value)


def ranks(values):
    order=sorted(range(len(values)),key=values.__getitem__);result=[0.]*len(values);i=0
    while i<len(order):
        j=i+1
        while j<len(order) and values[order[j]]==values[order[i]]:j+=1
        for k in order[i:j]:result[k]=(i+j-1)/2
        i=j
    return result


def rho(a,b):
    x,y=ranks(a),ranks(b);mx,my=statistics.mean(x),statistics.mean(y)
    dx=sum((v-mx)**2 for v in x);dy=sum((v-my)**2 for v in y)
    return max(-1.,min(1.,sum((u-mx)*(v-my) for u,v in zip(x,y))/math.sqrt(dx*dy))) if dx and dy else None


def pair(a,b,groups=None,min_n=30):
    indices=[i for i,(x,y) in enumerate(zip(a,b)) if finite(x) and finite(y)]
    detail={'n_overlap':len(indices),'n_used':0,'strata_used':0,'excluded_constant':0,'mask_sha256':digest(indices)}
    used=[];estimates=[]
    if groups is None:
        candidates=[indices]
    else:
        by_group=defaultdict(list)
        for i in indices:by_group[groups[i]].append(i)
        candidates=list(by_group.values())
    for selected in candidates:
        if len(selected)<(10 if groups is not None else min_n):continue
        value=rho([a[i] for i in selected],[b[i] for i in selected])
        if value is None:detail['excluded_constant']+=1;continue
        estimates.append((value,len(selected)));used.extend(selected)
    detail.update(n_used=len(used),strata_used=len(estimates),mask_sha256=digest(sorted(used)),first_index=min(used) if used else None,last_index=max(used) if used else None)
    enough=len(used)>=min_n and (groups is None or len(estimates)>=3)
    value=sum(v*n for v,n in estimates)/len(used) if enough else None
    detail['reason']='ok' if enough else ('constant' if detail['excluded_constant'] and not estimates else 'insufficient_pairs_or_strata')
    return [round(value,6) if value is not None else None,len(used) if enough else len(indices)],detail


def correlations(columns,groups=None,min_n=30):
    size=len(columns);values=[[None]*size for _ in columns];details=[[None]*size for _ in columns]
    for i in range(size):
        for j in range(i,size):
            value,detail=pair(columns[i],columns[j],groups,min_n)
            values[i][j]=values[j][i]=value;details[i][j]=details[j][i]=detail
    return values,details


def fetch_asset(url,cache,limit=16*1024**2):
    from api.server import atomic_json
    cache.mkdir(parents=True,exist_ok=True);key=hashlib.sha256(url.encode()).hexdigest();path=cache/(key+'.bin');meta=cache/(key+'.json')
    if path.exists() and meta.exists():return path.read_bytes(),json.loads(meta.read_text())
    with urlopen(Request(url,headers={'User-Agent':'NASA-Space-Apps-research/1.0'}),timeout=35) as response:
        raw=response.read(limit+1)
    if len(raw)>limit:raise ValueError('Источник вернул слишком большой ответ.')
    temporary=path.with_suffix('.part');temporary.write_bytes(raw);temporary.replace(path)
    info={'url':url,'sha256':hashlib.sha256(raw).hexdigest(),'retrieved_at':datetime.now(timezone.utc).isoformat(),'bytes':len(raw)}
    atomic_json(meta,info);return raw,info


def reserve_weather(cache,cost,progress):
    """Conservative weighted public-API budget. One matrix worker owns it."""
    from api.server import atomic_json
    path=cache/'weather-budget.json';now=time.time()
    entries=json.loads(path.read_text()) if path.exists() else []
    entries=[r for r in entries if now-r[0]<86400]
    if sum(c for t,c in entries)>9800-cost or sum(c for t,c in entries if now-t<3600)>4800-cost:
        raise ValueError('Достигнут лимит погодного источника. Уже рассчитанные матрицы доступны; новый расчёт повторите позже.')
    while sum(c for t,c in entries if time.time()-t<60)>550-cost:
        progress(message='Соблюдаю лимит погодного источника; расчёт продолжится автоматически')
        time.sleep(2)
    entries.append([time.time(),cost]);atomic_json(path,entries)


def numerical_weather(points,start,end,cache,progress):
    dates=[d.isoformat() for d in days_between(start-timedelta(days=7),end)]
    by_day={day:[None]*len(FIELDS) for day in dates};provenance=[];resolved=[]
    # Fixed ERA5, with a conservative five-day latency. Recent satellite dates
    # remain in the result but their unavailable weather covariates are null.
    stop=min(end,date.today()-timedelta(days=5))
    for year in range(start.year-1,end.year+1):
        first=max(start-timedelta(days=7),date(year,1,1));last=min(stop,date(year,12,31))
        if first>last:continue
        query={'latitude':','.join(str(p['lat']) for p in points),'longitude':','.join(str(p['lon']) for p in points),
            'start_date':str(first),'end_date':str(last),'models':'era5','timezone':'GMT','daily':','.join(FIELDS),
            'cell_selection':'nearest','elevation':','.join('nan' for _ in points),'wind_speed_unit':'ms'}
        url='https://archive-api.open-meteo.com/v1/archive?'+urlencode(query)
        key=hashlib.sha256(url.encode()).hexdigest()
        if not (cache/'sources'/(key+'.bin')).exists():reserve_weather(cache,max(1,math.ceil(((last-first).days+1)/14))*len(points),progress)
        raw,info=fetch_asset(url,cache/'sources');locations=json.loads(raw)
        if isinstance(locations,dict):locations=[locations]
        if len(locations)!=len(points):raise ValueError('Погода: число точек ответа отличается от запроса.')
        expected=[d.isoformat() for d in days_between(first,last)];by_grid={}
        for requested,location in zip(points,locations):
            lon,lat=location['longitude'],location['latitude'];data=location['daily'];units=location['daily_units']
            delta=abs((lon-requested['lon']+180)%360-180)
            if location['utc_offset_seconds']!=0 or abs(lat-requested['lat'])>.13 or delta>.13 or data['time']!=expected or any(units[f]!=u or len(data[f])!=len(expected) for f,u in zip(FIELDS,UNITS)):
                raise ValueError('Погодный источник вернул другие даты, единицы или ячейки ERA5.')
            grid=((lon+180)%360-180,lat)
            if grid not in by_grid:by_grid[grid]=[location,0.]
            by_grid[grid][1]+=requested['weight']
        resolved=[{'lon':lon,'lat':lat,'weight':v[1]} for (lon,lat),v in by_grid.items()]
        total_weight=sum(v[1] for v in by_grid.values())
        for i,day in enumerate(expected):
            values=[]
            for field in FIELDS:
                valid=[(loc['daily'][field][i],weight) for loc,weight in by_grid.values() if finite(loc['daily'][field][i])]
                # Do not change the regional support from day to day silently.
                values.append(sum(v*w for v,w in valid)/total_weight if sum(w for v,w in valid)>=total_weight*.999 else None)
            by_day[day]=values
        provenance.append(info)
        progress(message=f'Получены численные данные ERA5 за {year} год')
    conditions=[]
    for day in days_between(start,end):
        values=by_day[day.isoformat()]
        previous=[by_day.get((day-timedelta(days=i)).isoformat(),[None]*6)[2] for i in range(1,8)]
        rain7=sum(previous) if all(finite(v) for v in previous) else None
        conditions.append(values[:3]+[rain7]+values[3:])
    return conditions,{'model':'ERA5','resolution_degrees':.25,'timezone':'UTC','latency_days':5,'requested_points':points,'resolved_unique_grid_cells':resolved,'assets':provenance}


def tile_name(lon,lat):
    y=math.floor(lat/3)*3;x=math.floor(lon/3)*3
    if lat==y:y-=3  # North/top raster edge is included; south/bottom is not.
    return f"ESA_WorldCover_10m_2021_v200_{'N' if y>=0 else 'S'}{abs(y):02}{'E' if x>=0 else 'W'}{abs(x):03}_Map.tif"


def landcover(samples):
    """Read numerical categorical COG windows, never RGB tiles or whole archives."""
    import rasterio
    from numpy.ma import getmaskarray
    groups=defaultdict(list);values=[None]*len(samples);assets=[]
    for i,(lon,lat) in enumerate(samples):groups[tile_name(lon,lat)].append((i,lon,lat))
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',GDAL_HTTP_TIMEOUT=20,GDAL_HTTP_MAX_RETRY=1,GDAL_HTTP_RETRY_DELAY=1,GDAL_CACHEMAX=32*1024*1024):
        for tile,positions in groups.items():
            url='https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/'+tile
            try:
                with rasterio.open(url) as src:
                    for (i,lon,lat),value in zip(positions,src.sample([(x,y) for _,x,y in positions],masked=True)):
                        if not bool(getmaskarray(value)[0]) and int(value[0]) in [10,20,30,40,50,60,70,80,90,95,100]:values[i]=int(value[0])
                assets.append({'url':url,'status':'read','product':'WorldCover2021v200','method':'COG HTTP range; numerical point samples'})
            except (rasterio.errors.RasterioError,OSError) as error:
                assets.append({'url':url,'status':'unavailable','reason':type(error).__name__})
    return values,assets


def elevation(samples,cache,progress=lambda **kw:None):
    values=[];assets=[]
    for at in range(0,len(samples),100):
        part=samples[at:at+100];url='https://api.open-meteo.com/v1/elevation?'+urlencode({'latitude':','.join(str(y) for x,y in part),'longitude':','.join(str(x) for x,y in part)})
        key=hashlib.sha256(url.encode()).hexdigest()
        if not (cache/'sources'/(key+'.bin')).exists():reserve_weather(cache,len(part),progress)
        raw,info=fetch_asset(url,cache/'sources');data=json.loads(raw).get('elevation')
        if not isinstance(data,list) or len(data)!=len(part):raise ValueError('Высоты: неверное число точек.')
        values.extend(v if finite(v) else None for v in data);assets.append(info)
    return values,assets


def city_distances(points,cache):
    url='https://download.geonames.org/export/dump/cities5000.zip';raw,info=fetch_asset(url,cache/'sources')
    cities=[]
    with ZipFile(io.BytesIO(raw)) as archive,archive.open('cities5000.txt') as stream:
        for line in io.TextIOWrapper(stream,encoding='utf-8'):
            fields=line.split('\t');cities.append((math.radians(float(fields[4])),math.radians(float(fields[5]))))
    values=[]
    for lon,lat in points:
        p,l=math.radians(lat),math.radians(lon)
        best=min(math.sin((p-y)/2)**2+math.cos(p)*math.cos(y)*math.sin((l-x)/2)**2 for y,x in cities)
        values.append(2*6371.0088*math.asin(math.sqrt(min(1,max(0,best)))))
    return values,{**info,'scope':'GeoNames cities5000: cities over 5000 inhabitants or administrative seats; not every settlement','license':'CC BY'}


def sampling_grid(con,config,geometry,target=49,maximum=64):
    """Coarse cells align with the existing fine equal-area grid exactly."""
    encoded=json.dumps(geometry);grid=config['grid_km']*1000
    projected=con.execute("SELECT ST_AsWKB(ST_Transform(ST_GeomFromGeoJSON(?),'OGC:CRS84','EPSG:6933',always_xy:=true))",[encoded]).fetchone()[0]
    parts=con.execute('SELECT ST_XMin(d.geom),ST_YMin(d.geom),ST_XMax(d.geom),ST_YMax(d.geom) FROM (SELECT unnest(ST_Dump(ST_GeomFromWKB(?))) d)',[projected]).fetchall()
    area=con.execute('SELECT ST_Area(ST_GeomFromWKB(?))',[projected]).fetchone()[0]
    factor=max(1,math.ceil(math.sqrt(area/grid**2/target)))
    while True:
        size=grid*factor;coordinates=set();too_many=False
        for west,south,east,north in parts:
            x0,x1=math.floor(west/size),math.ceil(east/size);y0,y1=math.floor(south/size),math.ceil(north/size)
            if (x1-x0)*(y1-y0)>8192:too_many=True;break
            coordinates.update((x,y) for x in range(x0,x1) for y in range(y0,y1))
            if len(coordinates)>8192:too_many=True;break
        if too_many:factor*=2;continue
        con.execute('CREATE OR REPLACE TEMP TABLE matrix_coordinates(x INTEGER,y INTEGER)')
        con.executemany('INSERT INTO matrix_coordinates VALUES (?,?)',sorted(coordinates))
        con.execute('CREATE OR REPLACE TEMP TABLE matrix_units AS SELECT x gx,y gy,ST_CollectionExtract(ST_Intersection(ST_MakeEnvelope(x*?,y*?,(x+1)*?,(y+1)*?),ST_GeomFromWKB(?)),3) geom FROM matrix_coordinates',[size,size,size,size,projected])
        count=con.execute('SELECT count(*) FROM matrix_units WHERE ST_Area(geom)>1').fetchone()[0]
        if count<=maximum:break
        factor+=1
    rows=con.execute("SELECT gx,gy,ST_Area(geom)/1e6,ST_AsGeoJSON(ST_Transform(geom,'EPSG:6933','OGC:CRS84',always_xy:=true)),ST_X(ST_Transform(ST_PointOnSurface(geom),'EPSG:6933','OGC:CRS84',always_xy:=true)),ST_Y(ST_Transform(ST_PointOnSurface(geom),'EPSG:6933','OGC:CRS84',always_xy:=true)) FROM matrix_units WHERE ST_Area(geom)>1 ORDER BY gy,gx").fetchall()
    units=[];samples=[]
    for x,y,area,shape,lon,lat in rows:
        points=[]
        for dy in [.2,.5,.8]:
            for dx in [.2,.5,.8]:
                px,py=(x+dx)*size,(y+dy)*size
                point=con.execute("SELECT ST_Intersects(geom,ST_Point(?,?)),ST_X(ST_Transform(ST_Point(?,?),'EPSG:6933','OGC:CRS84',always_xy:=true)),ST_Y(ST_Transform(ST_Point(?,?),'EPSG:6933','OGC:CRS84',always_xy:=true)) FROM matrix_units WHERE gx=? AND gy=?",[px,py,px,py,px,py,x,y]).fetchone()
                if point[0]:points.append([point[1],point[2]])
        if not points:points=[[lon,lat]]
        units.append({'id':f'{x}:{y}','gx':x,'gy':y,'centroid':[lon,lat],'area_km2':area,'geometry':json.loads(shape),'samples':points,'values':[],'fire':{}})
        samples.extend(points)
    return units,samples,factor


def weather_points(con,geometry):
    # Component-aware strata also preserve narrow and dateline-crossing areas.
    units,_,_=sampling_grid(con,{'grid_km':10},geometry,target=9,maximum=9)
    points=[{'lon':round(u['centroid'][0],6),'lat':round(u['centroid'][1],6),'weight':u['area_km2']} for u in units]
    total=sum(p['weight'] for p in points)
    if not total:raise ValueError('В выделении нет площади для погодной выборки.')
    for point in points:point['weight']/=total
    return points


def fire_series(analysis,dates):
    config=analysis['config'];available={(r['date'],r['platform']):r['sp'] for r in analysis['availability']}
    daily={(r['date'],r['platform']):r['cells'] for r in analysis['daily']}
    last=analysis['through'][:10]
    return {p:[daily.get((d,p),0) if (d,p) in available and (config['quality']=='all' or available[d,p]) and d<last else None for d in dates] for p in PLATFORMS}


def build(analysis,analysis_id,progress):
    from api import server
    config=analysis['config'];cache=server.CACHE/'matrix';cache.mkdir(parents=True,exist_ok=True)
    key=digest({'extract':analysis['extract_id'],'config':config,'version':VERSION})
    saved=cache/'results'/(key+'.json')
    if saved.exists():
        result=json.loads(saved.read_text())
        if not result.get('warnings_sources') or time.time()-saved.stat().st_mtime<300:
            result['analysis_id']=analysis_id;return result
    geometry=server.query_geometry(config);start,end=date.fromisoformat(config['start']),date.fromisoformat(config['end'])
    warnings=[];provenance={'geometry_sha256':digest(geometry),'satellite':analysis['provenance'],'weather':None,'landcover':None,'elevation':None,'cities':None}
    with ExitStack() as scope:
        for attempt in range(12):
            try:
                scope.enter_context(server.map_guard(analysis['extract_id']));break
            except server.BusyMapError:
                if attempt==11:raise
                progress(message='Дожидаюсь завершения текущего запроса карты');time.sleep(.5)
        con=server.connection(cache/'temporary',memory='192MB')
        try:
            units,samples,factor=sampling_grid(con,config,geometry);points=weather_points(con,geometry)
            paths=[str(p) for p in (server.CACHE/'extracts'/analysis['extract_id']).glob('*.parquet')]
            if not paths:raise ValueError('Пространственный кэш истёк. Постройте анализ заново перед расчётом матрицы.')
            counts=con.execute('SELECT platform,floor(gx/?)::INTEGER,floor(gy/?)::INTEGER,sum(days)::DOUBLE FROM read_parquet(?) WHERE day<?::DATE GROUP BY 1,2,3',[factor,factor,paths,analysis['through'][:10]]).fetchall() if paths else []
        finally:con.close()
    progress(progress=10,message='Получаю глобальную погодную выборку ERA5')
    try:conditions,provenance['weather']=numerical_weather(points,start,end,cache,progress)
    except (HTTPError,OSError,ValueError) as error:
        conditions=[[None]*7 for day in days_between(start,end)]
        provenance['weather']={'status':'unavailable','reason':str(error)[:200]}
        warnings.append('Численные данные ERA5 недоступны: '+str(error)[:200])
    progress(progress=55,message='Читаю численные высоты и классы землепокрова')
    # Each source may be unavailable independently. That factor stays null.
    try:
        cover,provenance['landcover']=landcover(samples)
        if any(asset['status']!='read' for asset in provenance['landcover']):warnings.append('Часть численных тайлов WorldCover недоступна; соответствующие факторы не оценены.')
    except (ImportError,OSError,ValueError) as error:cover=[None]*len(samples);warnings.append('WorldCover недоступен: '+type(error).__name__)
    try:heights,provenance['elevation']=elevation(samples,cache,progress)
    except (HTTPError,OSError,ValueError) as error:heights=[None]*len(samples);warnings.append('GLO-90 недоступен: '+type(error).__name__)
    try:distances,provenance['cities']=city_distances([u['centroid'] for u in units],cache)
    except (HTTPError,OSError,ValueError) as error:distances=[None]*len(units);warnings.append('GeoNames недоступен: '+type(error).__name__)
    dates=[d.isoformat() for d in days_between(start,end)];fire=fire_series(analysis,dates)
    eligible={p:sum(finite(v) for v in fire[p]) for p in PLATFORMS};count_by={(p,x,y):v for p,x,y,v in counts};at=0
    for unit,distance in zip(units,distances):
        length=len(unit['samples']);cv=cover[at:at+length];hv=heights[at:at+length];at+=length
        valid_cover=[v for v in cv if finite(v)];valid_height=[v for v in hv if finite(v)]
        covers=[100*sum(v==code for v in valid_cover)/len(valid_cover) if len(valid_cover)>=max(3,math.ceil(.75*length)) else None for code in [10,30,40,90]]
        height=statistics.median(valid_height) if len(valid_height)>=3 else None
        relief=quantile(valid_height,.9)-quantile(valid_height,.1) if len(valid_height)>=3 else None
        unit['values']=[distance,height,relief]+covers;unit['sample_coverage']={'total':length,'landcover':len(valid_cover),'elevation':len(valid_height)}
        unit['fire']={p:count_by.get((p,unit['gx'],unit['gy']),0)/unit['area_km2']/eligible[p] if eligible[p] else None for p in PLATFORMS}
        coordinates=[pt for polygon in ([unit['geometry']['coordinates']] if unit['geometry']['type']=='Polygon' else unit['geometry']['coordinates']) for ring in polygon for pt in ring]
        unit['bbox']=[min(p[0] for p in coordinates),min(p[1] for p in coordinates),max(p[0] for p in coordinates),max(p[1] for p in coordinates)]
    progress(progress=85,message='Считаю матрицы и проверяю достаточность пар')
    columns=list(map(list,zip(*conditions)));groups=[d[:7] for d in dates];results={};details={}
    for platform in PLATFORMS:
        all_columns=[fire[platform]]+columns
        within,wd=correlations(all_columns,groups);pooled,pd=correlations(all_columns)
        spatial=[[u['fire'][platform] for u in units]]+[[u['values'][i] for u in units] for i in range(len(SPACE_FACTORS)-1)]
        space,sd=correlations(spatial,min_n=20)
        for matrix in [wd,pd]:
            for row in matrix:
                for item in row:
                    item['first_date']=dates[item['first_index']] if item['first_index'] is not None else None
                    item['last_date']=dates[item['last_index']] if item['last_index'] is not None else None
        results[platform]={'within':within,'pooled':pooled,'space':space};details[platform]={'within':wd,'pooled':pd,'space':sd}
    result={'version':VERSION,'analysis_id':analysis_id,'config':config,'extract_id':analysis['extract_id'],'snapshot_at':analysis['snapshot_at'],'through':analysis['through'],'platforms':PLATFORMS,
        'time_factors':[dict(zip(['id','label','short','unit'],v)) for v in TIME_FACTORS],'space_factors':[dict(zip(['id','label','short','unit'],v)) for v in SPACE_FACTORS],
        'results':results,'pair_details':details,'time_series':{'dates':dates,'conditions':conditions,'fire':fire},'space_units':units,'provenance':provenance,
        'created_at':datetime.now(timezone.utc).isoformat(),'spatial_grid_km':config['grid_km']*factor,
        'warnings_sources':warnings,
        'warnings':warnings+['Матрица описательная; корреляция не доказывает причину. P-value и значимость не оцениваются.',
            'Внутримесячный режим: среднее Spearman по отдельным годам-месяцам с весом по числу пар; нужны ≥30 пар, ≥3 непостоянных групп по ≥10 дней.',
            'Для пространственного коэффициента нужны ≥20 ячеек. Данные соседних ячеек и суток зависимы.',
            'Погода — равноплощадная выборка ERA5, а не подробное измерение каждого места. Облачность ERA5 не является маской видимости спутника.',
            'WorldCover — статический контекст 2021; доли и высоты оценены по точкам внутри каждой ячейки, не по всем пикселям территории.',
            'Использованы исходные ячейко-дни выбранной платформы и качества. Межплатформенные суммы и коэффициенты СКО не используются.']}
    server.atomic_json(saved,result);return result
