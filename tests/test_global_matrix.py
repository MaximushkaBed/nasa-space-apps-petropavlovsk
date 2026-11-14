from datetime import date
import copy
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from api.matrix import pair,correlations,tile_name,numerical_weather,FIELDS,UNITS,sampling_grid,weather_points,fire_series


class MatrixStatisticsTests(unittest.TestCase):
    def test_partial_cog_result_cache_can_recover_without_sko_fallback(self):
        from api import server,matrix
        class Cursor:
            def fetchall(self):return []
        class Con:
            def execute(self,*args):return Cursor()
            def close(self):pass
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);key='a'*32;folder=root/'extracts'/key;folder.mkdir(parents=True);(folder/'2020.parquet').touch()
            cfg={'preset':'custom','bbox':[0,0,1,1],'start':'2020-01-01','end':'2020-03-31','baseline_start':2020,'baseline_end':2020,'grid_km':10,'quality':'sp','daynight':'all'}
            analysis={'config':cfg,'extract_id':key,'through':'2020-04-01T00:00:00Z','snapshot_at':'fixture','provenance':{},'daily':[],'availability':[]}
            units=[{'gx':i,'gy':0,'area_km2':1,'samples':[[0,0]]*9,'centroid':[0,0],'geometry':{'type':'Polygon','coordinates':[[[0,0],[1,0],[1,1],[0,0]]]},'values':[],'fire':{}} for i in range(20)]
            with patch.object(server,'CACHE',root),patch.object(server,'connection',return_value=Con()),patch.object(matrix,'sampling_grid',side_effect=lambda *a:(copy.deepcopy(units),[[0,0]]*180,1)),patch.object(matrix,'weather_points',return_value=[{'lat':0,'lon':0,'weight':1}]),patch.object(matrix,'numerical_weather',return_value=([[float(i)]*7 for i in range(91)],{})),patch.object(matrix,'elevation',return_value=(list(range(180)),[])),patch.object(matrix,'city_distances',return_value=(list(range(20)),{})),patch.object(matrix,'landcover',side_effect=[([None]*180,[{'status':'unavailable'}]),([10]*180,[{'status':'read'}])]) as cover:
                first=matrix.build(analysis,'first',lambda **kw:None)
                saved=next((root/'matrix/results').glob('*.json'));os.utime(saved,(time.time()-3600,time.time()-3600))
                second=matrix.build(analysis,'second',lambda **kw:None)
                self.assertTrue(first['warnings_sources']);self.assertEqual(cover.call_count,2)
                self.assertEqual(second['analysis_id'],'second');self.assertEqual(second['provenance']['landcover'][0]['status'],'read')

    def test_fire_absence_quality_and_incomplete_date_are_not_observed_zero(self):
        analysis={'config':{'quality':'sp'},'through':'2025-04-05T04:00:00Z',
            'daily':[{'date':'2025-04-02','platform':'Aqua','cells':7}],
            'availability':[{'date':d,'platform':'Aqua','sp':sp} for d,sp in [('2025-04-01',True),('2025-04-02',True),('2025-04-04',False),('2025-04-05',True)]]}
        dates=[f'2025-04-{i:02}' for i in range(1,6)]
        self.assertEqual(fire_series(analysis,dates)['Aqua'],[0,7,None,None,None])
        analysis['config']['quality']='all'
        self.assertEqual(fire_series(analysis,dates)['Aqua'],[0,7,None,0,None])

    def test_within_month_does_not_mistake_seasonality_for_daily_relationship(self):
        x=[];y=[];groups=[]
        for month,offset in enumerate([0,100,200]):
            x.extend(offset+i for i in range(30));y.extend(offset+29-i for i in range(30));groups.extend([month]*30)
        pooled,_=pair(x,y);within,detail=pair(x,y,groups)
        self.assertGreater(pooled[0],0);self.assertEqual(within,[-1.,90]);self.assertEqual(detail['strata_used'],3)

    def test_missing_constant_and_tied_values_are_distinct_from_zero_correlation(self):
        value,detail=pair([0]*40,list(range(40)))
        self.assertIsNone(value[0]);self.assertEqual(detail['reason'],'constant')
        value,_=pair([1,1,2,2]*10,[2,2,1,1]*10);self.assertEqual(value[0],-1.)
        values,_=correlations([[None]*40,list(range(40)),list(reversed(range(40)))])
        self.assertIsNone(values[0][1][0]);self.assertEqual(values[1][2],[-1.,40])

    def test_spatial_threshold_and_southern_western_cog_names(self):
        self.assertIsNone(pair(list(range(19)),list(range(19)),min_n=20)[0][0])
        self.assertEqual(tile_name(-120.1,36.2),'ESA_WorldCover_10m_2021_v200_N36W123_Map.tif')
        self.assertEqual(tile_name(-57.1,-12.1),'ESA_WorldCover_10m_2021_v200_S15W060_Map.tif')
        self.assertEqual(tile_name(69,54),'ESA_WorldCover_10m_2021_v200_N51E069_Map.tif')
        self.assertEqual(tile_name(-55,-12),'ESA_WorldCover_10m_2021_v200_S15W057_Map.tif')

    def test_weather_uses_previous_days_and_resolved_unique_cells(self):
        # Two requested ROI points resolve to one real meteorological cell.
        days=[f'2020-01-{d:02}' for d in range(1,11)]
        loc={'latitude':0.,'longitude':0.,'utc_offset_seconds':0,'daily_units':dict(zip(FIELDS,UNITS)),
            'daily':{'time':days,**{f:[float(i) for i in range(10)] for f in FIELDS}}}
        points=[{'lat':.01,'lon':.01,'weight':.6},{'lat':.02,'lon':.02,'weight':.4}]
        with tempfile.TemporaryDirectory() as directory,patch('api.matrix.fetch_asset',return_value=(json.dumps([loc,loc]).encode(),{'sha256':'realfixture'})),patch('api.matrix.reserve_weather'):
            conditions,provenance=numerical_weather(points,date(2020,1,8),date(2020,1,10),Path(directory),lambda **kw:None)
        self.assertEqual(conditions[0][3],sum(range(7)))  # Jan1–7, excluding Jan8.
        self.assertEqual(conditions[0][0],7)
        self.assertEqual(len(provenance['resolved_unique_grid_cells']),1)
        self.assertEqual(provenance['resolved_unique_grid_cells'][0]['weight'],1)


class ExactGeometryTests(unittest.TestCase):
    def test_polygon_holes_sampling_area_and_cross_dateline_circle(self):
        from api import server
        from api.geometry import circle_polygon
        geometry={'type':'Polygon','coordinates':[[[0,0],[2,0],[2,2],[0,2],[0,0]],[[.7,.7],[.7,1.3],[1.3,1.3],[1.3,.7],[.7,.7]]]}
        cfg=server.validate({'geometry':geometry,'preset':'custom','roi_name':'Geometry with hole','start':'2020-01-01','end':'2025-12-31','baseline_start':2020,'baseline_end':2023,'grid_km':10})
        self.assertEqual(cfg['geometry']['coordinates'][1],geometry['coordinates'][1])
        con=server.connection()
        try:
            units,samples,factor=sampling_grid(con,cfg,server.query_geometry(cfg))
            expected=con.execute("SELECT ST_Area(ST_Transform(ST_GeomFromGeoJSON(?),'OGC:CRS84','EPSG:6933',always_xy:=true))/1e6",[json.dumps(geometry)]).fetchone()[0]
            self.assertAlmostEqual(sum(u['area_km2'] for u in units),expected,places=5)
            self.assertLessEqual(len(units),64);self.assertGreaterEqual(len(units),20)
            for lon,lat in samples:self.assertFalse(.7<lon<1.3 and .7<lat<1.3)
            points=weather_points(con,geometry);self.assertAlmostEqual(sum(p['weight'] for p in points),1)
        finally:con.close()
        circle=circle_polygon({'center':[179.9,20],'radius_km':50})
        self.assertEqual(circle['type'],'MultiPolygon')
        cfg['geometry']=circle;validated=server.validate(cfg)
        self.assertEqual(validated['geometry']['type'],'MultiPolygon')
        con=server.connection()
        try:
            dateline,_,factor=sampling_grid(con,{'grid_km':10},circle)
            self.assertGreaterEqual(len(dateline),20)
            self.assertLessEqual(factor,3)
            self.assertGreater(sum(len(u['samples']) for u in dateline),len(dateline)*3)
        finally:con.close()

    def test_invalid_geometry_cannot_be_silently_replaced_by_a_rectangle(self):
        from api.server import validate
        base={'preset':'custom','bbox':[0,0,1,1],'start':'2020-01-01','end':'2025-12-31','baseline_start':2020,'baseline_end':2023}
        for ring in [[ [0,0],[1,1],[0,1],[1,0],[0,0] ],[[0,0],[1,0],[0,1],[float('nan'),0]]]:
            with self.assertRaises(ValueError):validate({**base,'geometry':{'type':'Polygon','coordinates':[ring]}})


if __name__=='__main__':unittest.main()
