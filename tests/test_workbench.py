from datetime import date,timedelta
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from api.analysis import analyze


def config(**kwargs):
    return dict({'bbox':[68,53,71,55],'preset':'custom','start':'2020-01-01','end':'2025-12-31',
        'baseline_start':2020,'baseline_end':2023,'grid_km':10,'quality':'sp','daynight':'all'},**kwargs)


def paired():
    rows=[];available=[]
    for year in range(2020,2026):
        for month in range(1,13):
            for day in range(1,13):
                for platform,cells in [('Aqua',2),('NOAA-20',5)]:
                    d=f'{year}-{month:02}-{day:02}'
                    rows.append({'date':d,'platform':platform,'cells':cells,'points':cells*3,'sp_cells':cells,'nrt_points':0})
                    available.append({'date':d,'platform':platform,'sp':True})
    return rows,available


class TemporalAnalysisTests(unittest.TestCase):
    def test_local_fit_is_checked_on_later_years(self):
        rows,available=paired();result=analyze(rows,available,config())
        model=result['models']['NOAA-20']
        self.assertAlmostEqual(model['coefficient'],.4)
        self.assertEqual((model['fit_months'],model['test_months']),(48,24))
        self.assertTrue(model['accepted']);self.assertEqual(model['mae_after'],0)
        for r in rows:
            if r['date']>='2024' and r['platform']=='Aqua':r['sp_cells']=100
        changed=analyze(rows,available,config())['models']['NOAA-20']
        self.assertEqual(changed['coefficient'],.4)  # Test targets cannot leak into the fit.
        self.assertFalse(changed['accepted'])

    def test_evaluated_year_is_excluded_from_its_baseline(self):
        rows,available=paired();result=analyze(rows,available,config())
        by={(r['month'],r['platform']):r for r in result['monthly']}
        self.assertEqual(by['2020-04','NOAA-20']['baseline_years'],3)
        self.assertEqual(by['2025-04','NOAA-20']['baseline_years'],4)
        self.assertEqual(by['2025-04','NOAA-20']['anomaly_pct'],0)

    def test_partial_month_does_not_use_later_baseline_days(self):
        available=[{'date':f'{y}-04-{d:02}','platform':'Aqua','sp':True} for y in [2020,2021,2022,2023,2025] for d in range(1,31)]
        rows=[{'date':f'{y}-04-20','platform':'Aqua','cells':100,'points':100,'sp_cells':100} for y in range(2020,2024)]
        result=analyze(rows,available,config(end='2025-04-14'))
        row=next(r for r in result['monthly'] if r['month']=='2025-04' and r['platform']=='Aqua')
        self.assertTrue(row['partial']);self.assertEqual(row['baseline'],0);self.assertEqual(row['eligible_days'],14)

    def test_no_product_is_not_a_zero_and_outages_are_removed(self):
        result=analyze([], [{'date':'2020-01-01','platform':'Aqua','sp':True}],config(end='2020-01-31',baseline_end=2020),{('2020-01-01','Aqua')})
        self.assertTrue(all(row['cells'] is None for row in result['monthly']))

    def test_known_target_outage_cannot_create_false_monthly_anomaly(self):
        available=[{'date':f'{y}-04-{d:02}','platform':'Aqua','sp':True} for y in [2020,2021,2022,2023,2025] for d in range(1,31)]
        rows=[{'date':f'{y}-04-01','platform':'Aqua','cells':100,'points':100,'sp_cells':100} for y in [2020,2021,2022,2023,2025]]
        excluded={(f'2025-04-{d:02}','Aqua') for d in range(2,31)}
        output=analyze(rows,available,config(),excluded)
        row=next(r for r in output['monthly'] if r['month']=='2025-04' and r['platform']=='Aqua')
        self.assertIsNone(row['anomaly_pct'])
        self.assertEqual(row['comparison_status'],'insufficient_target_days')
        # With a sufficiently large target mask, historical dates must match it exactly.
        output=analyze(rows,available,config(),{(f'2025-04-{d:02}','Aqua') for d in range(16,31)})
        row=next(r for r in output['monthly'] if r['month']=='2025-04' and r['platform']=='Aqua')
        self.assertEqual(row['baseline'],100)
        self.assertEqual(row['anomaly_pct'],0)

    def test_sp_acceptance_never_validates_nrt_values(self):
        rows,available=paired()
        for row in rows:
            if row['date']>='2024' and row['platform']=='NOAA-20':
                row['cells']+=1000;row['points']+=1000;row['nrt_points']=1000
        output=analyze(rows,available,config(quality='all'))
        self.assertTrue(output['models']['NOAA-20']['accepted'])
        row=next(r for r in output['monthly'] if r['month']=='2025-04' and r['platform']=='NOAA-20')
        self.assertFalse(row['calibration_eligible']);self.assertFalse(row['model_valid'])
        self.assertIsNone(row['aqua_equivalent'])

    def test_sp_target_does_not_validate_mixed_nrt_historical_baseline(self):
        rows,available=paired()
        for row in rows:
            if row['date']<'2024' and row['platform']=='NOAA-20':
                row['cells']+=1000;row['nrt_points']=1000
        output=analyze(rows,available,config(quality='all'))
        self.assertTrue(output['models']['NOAA-20']['accepted'])
        row=next(r for r in output['monthly'] if r['month']=='2025-04' and r['platform']=='NOAA-20')
        self.assertTrue(row['model_valid'])
        self.assertEqual(row['aqua_equivalent'],24)
        self.assertEqual(row['baseline'],12060)  # Raw mixed reference is preserved.
        self.assertFalse(row['baseline_calibration_eligible'])
        self.assertIsNone(row['baseline_equivalent'])
        # A NRT-only global product day also makes the reference ineligible,
        # even where it contains no local detections.
        rows,available=paired()
        for r in available:
            if r['date']=='2020-04-02' and r['platform']=='NOAA-20':r['sp']=False
        output=analyze(rows,available,config(quality='all'))
        row=next(r for r in output['monthly'] if r['month']=='2025-04' and r['platform']=='NOAA-20')
        self.assertFalse(row['baseline_calibration_eligible'])
        self.assertIsNone(row['baseline_equivalent'])

    def test_iso_year_boundary_observations_are_preserved_and_labeled(self):
        rows=[];available=[]
        for y in range(2020,2026):
            for d in [29,30,31]:
                key=f'{y}-12-{d}'
                available.append({'date':key,'platform':'Aqua','sp':True})
                rows.append({'date':key,'platform':'Aqua','cells':100,'points':100,'sp_cells':100})
        output=analyze(rows,available,config())['weekly_profiles']['Aqua']
        self.assertEqual(output['year_basis'],'ISO')
        self.assertEqual(sum(r['total_cells'] for r in output['year_metrics'].values()),1800)
        self.assertIn('2026',output['years'])
        self.assertTrue(output['year_metrics']['2026']['partial_year'])
        self.assertEqual(len(output['weeks']),53)

    def test_incomplete_last_utc_day_disables_period_anomaly(self):
        rows,available=paired()
        output=analyze(rows,available,config(incomplete_utc_dates=['2025-04-12']))
        row=next(r for r in output['monthly'] if r['month']=='2025-04' and r['platform']=='NOAA-20')
        self.assertEqual(row['comparison_status'],'incomplete_utc_day')
        self.assertIsNone(row['anomaly_pct'])


class SpatialQueryTests(unittest.TestCase):
    def test_query_filters_region_quality_outages_and_preserves_cell_day_units(self):
        import duckdb
        from api import server
        try:
            c=server.connection();c.close()
        except duckdb.Error:
            self.skipTest('Spatial extension must be installed for integration test')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'data';cache=Path(directory)/'cache';root.mkdir();cache.mkdir();(root/'.sync.lock').touch()
            file=root/'observations/year=2020/detections.parquet';file.parent.mkdir(parents=True)
            c=server.connection()
            c.execute("""CREATE TABLE observations AS SELECT '2020-04-01 12:00:00'::TIMESTAMP acq_datetime,
                'NOAA-20' satellite,'VIIRS' instrument,'sp' quality,0 type,'h' confidence,
                NULL::INTEGER confidence_pct,'D' daynight,'POINT(69 54)'::GEOMETRY('OGC:CRS84') geometry""")
            c.execute('INSERT INTO observations SELECT * FROM observations')
            c.execute("INSERT INTO observations SELECT acq_datetime,satellite,instrument,quality,type,'l',confidence_pct,daynight,geometry FROM observations LIMIT 1")
            c.execute("INSERT INTO observations SELECT acq_datetime,satellite,instrument,quality,type,confidence,confidence_pct,daynight,'POINT(120 40)'::GEOMETRY('OGC:CRS84') FROM observations LIMIT 1")
            c.execute('COPY observations TO ? (FORMAT PARQUET)',[str(file)]);c.close()
            asset={'path':str(file.relative_to(root)),'kind':'observations','year':2020,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
            (root/'manifest.json').write_text(json.dumps({'status':'ready','assets':{asset['path']:asset},'updated_at':'2026-11-14'}))
            cfg=config(start='2020-04-01',end='2020-04-30',baseline_end=2020)
            server.JOBS['test']={'status':'queued'}
            with patch.object(server,'DATA',root),patch.object(server,'CACHE',cache):
                with server.pinned_sources(cfg) as (_,sources):
                    extracted=server.extract('test',cfg,sources,'a'*32)
                row=extracted['daily'][0]
                self.assertEqual((row['points'],row['cells']),(2,1))
                maps=server.map_cells('a'*32,'2020-04','NOAA-20')
                self.assertEqual(len(maps['cells']),1)
                self.assertEqual(maps['cells'][0][4:],(1,2))
                self.assertEqual(server.map_cells('a'*32,'2020-04','NOAA-20','2020-04-02')['cells'],[])
                with self.assertRaises(ValueError):server.map_cells('../../secret','2020-04','NOAA-20')
                world = server.validate({**cfg, 'preset': 'world'})
                self.assertEqual((world['bbox'], world['grid_km']), ([-180, -85, 180, 85], 250))
                with server.pinned_sources(world) as (_, sources):
                    global_row = server.extract('test', world, sources, 'b'*32)['daily'][0]
                self.assertEqual((global_row['points'], global_row['cells']), (3, 2))

    def test_anomaly_map_uses_cell_days_and_same_baseline_dates(self):
        from api import server
        try:
            con=server.connection();con.close()
        except Exception:
            self.skipTest('Spatial extension required')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);key='b'*32;folder=root/'extracts'/key;folder.mkdir(parents=True)
            cfg=config(end='2024-12-31',bbox=[-1,-1,1,1])
            (folder/'grid.json').write_text(json.dumps({'grid_km':10,'config':cfg,'through':'2025-01-01T00:00:00Z'}))
            daily=[];availability=[]
            for year in range(2020,2025):
                con=server.connection()
                con.execute('CREATE TABLE cells(day DATE,month VARCHAR,platform VARCHAR,gx INTEGER,gy INTEGER,days INTEGER,points INTEGER)')
                rows=[]
                for day in range(1,13):
                    d=f'{year}-04-{day:02}'
                    rows.append((d,f'{year}-04','NOAA-20',0,0,1,2 if year==2024 else 1))
                    daily.append({'date':d,'platform':'NOAA-20','cells':1,'points':2 if year==2024 else 1,'sp_cells':1,'nrt_points':0})
                    availability.append({'date':d,'platform':'NOAA-20','sp':True})
                con.executemany('INSERT INTO cells VALUES (?,?,?,?,?,?,?)',rows)
                con.execute('COPY cells TO ? (FORMAT PARQUET)',[str(folder/f'{year}.parquet')]);con.close()
            (folder/'daily.json').write_text(json.dumps({'daily':daily,'availability':availability}))
            with patch.object(server,'CACHE',root):
                output=server.anomaly_map(key,'2024-04','NOAA-20',2020,2023)
                self.assertEqual(output['status'],'ok');self.assertEqual(output['baseline_years'],4)
                self.assertEqual(output['cells'][0][4:],(12,12,0,4))
                annual=server.map_cells(key,'2024','NOAA-20')
                self.assertEqual(annual['year_basis'],'ISO')
                self.assertEqual(sum(r[4] for r in annual['cells']),12)
                window=server.map_cells(key,'2024-04','NOAA-20',start='2024-04-03',end='2024-04-05')
                self.assertEqual(sum(r[4] for r in window['cells']),3)
                self.assertEqual((window['start_date'],window['end_date'],window['year_basis']),('2024-04-03','2024-04-05','UTC-range'))
                with self.assertRaises(ValueError):server.map_cells(key,'2024-04','NOAA-20',start='2019-01-01',end='2024-04-05')

    def test_archive_can_omit_optional_live_tail(self):
        from api.server import archive_through
        self.assertEqual(archive_through({'assets':{'x':{'kind':'observations','end':'2025-12-31T23:00:00Z'}},'live_tail':None}),'2025-12-31T23:00:00Z')

    def test_concurrent_map_is_bounded(self):
        from api import server
        server.MAP_LIMIT.acquire()
        try:
            with self.assertRaises(server.BusyMapError):server.map_cells('a'*32,'2020-04','NOAA-20')
        finally:server.MAP_LIMIT.release()

    def test_untrusted_query_values_are_rejected(self):
        from api.server import validate
        for field,bad in [('grid_km',2.9),('baseline_start',2020.9),('grid_km',True),('baseline_end',False)]:
            with self.subTest(field=field,value=bad),self.assertRaises(ValueError):
                validate(config(**{field:bad}))
        for value in [config(bbox=[0,0,float('nan'),2]),config(bbox=[-180,-85,180,85]),config(grid_km=1),config(quality="sp' OR TRUE")]:
            with self.assertRaises(ValueError):validate(value)
