from pathlib import Path
import argparse
import csv
import json
import math

import numpy as np
from PIL import Image
import rasterio
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import transform_bounds, reproject, Resampling
from rasterio.vrt import WarpedVRT
from rasterio.features import shapes, rasterize
from scipy import ndimage as ndi
from shapely import transform, make_valid
from shapely.geometry import shape, mapping, box, Point
from shapely.ops import unary_union
from pyproj import Transformer

PROJECT_ROOT = Path(__file__).resolve().parents[1]
AOI = (71.68,53.035,72.013,53.346)
UTM = 'EPSG:32642'
CADA = '+proj=tmerc +lat_0=0 +lon_0=69 +k=1 +x_0=12500000 +y_0=0 +ellps=GRS80 +units=m +no_defs'
WEST, SOUTH, EAST, NORTH = transform_bounds('EPSG:4326', UTM, *AOI)
WEST, SOUTH = 20*math.floor(WEST/20), 20*math.floor(SOUTH/20)
EAST, NORTH = 20*math.ceil(EAST/20), 20*math.ceil(NORTH/20)
GRID = from_origin(WEST,NORTH,20,20)
W,H = (round((EAST-WEST)/20),round((NORTH-SOUTH)/20))
to_utm=Transformer.from_crs('EPSG:4326',UTM,always_xy=True).transform
to_ll=Transformer.from_crs(UTM,'EPSG:4326',always_xy=True).transform
cad_utm=Transformer.from_crs(CADA,UTM,always_xy=True).transform
clip=transform(box(*AOI),to_utm,interleaved=False)


def scenes(day):
    for tile in ('42UXE','42UXD'):
        yield f'S2C_{tile}_{day.replace("-","")}_0_L2A'


def read(asset):
    with rasterio.open(asset) as src, WarpedVRT(src,crs=UTM,width=W,height=H,transform=GRID,
            resampling=Resampling.nearest if asset.name.endswith('scl.tif') else Resampling.average) as vrt:
        return vrt.read(1)


def mosaic(inputs, day):
    scl = np.zeros((H,W),np.uint8)
    data = np.zeros((3,H,W),np.uint16)
    for scene in scenes(day):
        mask=read(inputs/f'{scene}-scl.tif')
        replace=(scl==0)|(np.isin(mask,[4,5,6])&~np.isin(scl,[4,5,6]))
        for i,key in enumerate(('swir22','nir','red')):
            vals=read(inputs/f'{scene}-{key}.tif')
            data[i][replace]=vals[replace]
        scl[replace]=mask[replace]
    return data, scl


def geojson(path, features):
    path.write_text(json.dumps({'type':'FeatureCollection','features':features},
                                ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')


def feature(geom, **props):
    def to_wgs84(x, y):
        return np.round(to_ll(x,y),6)
    return dict(type='Feature',geometry=mapping(transform(geom, to_wgs84, interleaved=False)),properties=props)


def hotspots():
    cells = json.loads((PROJECT_ROOT / 'web/data/2025-04.json').read_text(encoding='utf-8'))
    selected = [a[:4] for index in cells['frames'][11][2] if (a:=cells['cells'][index])[0] >= 71.699312
                and a[2]<=71.989511 and a[1]>=53.048633 and a[3]<=53.333997]
    locations = unary_union([box(*bounds) for bounds in selected])
    with (PROJECT_ROOT / 'data/cache/sko-validation/2025.csv').open(encoding='utf-8-sig', newline='') as stream:
        for row in csv.DictReader(stream):
            if (row['satellite'] != 'NOAA-20' or row['quality'] != 'sp' or row['type'] != '0'
                    or row['confidence'] not in {'n', 'h'} or not row['acq_datetime'].startswith('2025-04-12')):
                continue
            point = Point(float(row['longitude']), float(row['latitude']))
            if locations.covers(point):
                yield transform(point, to_utm, interleaved=False), row['acq_datetime'][11:16]


def main(inputs):
    before, a = mosaic(inputs, '2025-04-06')
    after, b = mosaic(inputs, '2025-04-16')
    good = np.isin(a,[4,5]) & np.isin(b,[4,5])
    usable = good & np.all(before>0,axis=0) & np.all(after>0,axis=0)
    before_scale=before.astype('float32')/10000
    after_scale=after.astype('float32')/10000
    s1,n1,_ = before_scale
    s2,n2,_ = after_scale
    nbr1 = np.divide(n1-s1,n1+s1,out=np.zeros_like(n1),where=n1+s1>.025)
    nbr2 = np.divide(n2-s2,n2+s2,out=np.zeros_like(n2),where=n2+s2>.025)
    dnbr=nbr1-nbr2
    detections=list(hotspots())
    near = unary_union([point.buffer(2400) for point,_ in detections])
    near_grid = rasterize([(near,1)],out_shape=(H,W),transform=GRID).astype(bool)
    aoi = rasterize([(clip,1)],out_shape=(H,W),transform=GRID).astype(bool)
    valid = usable & aoi & (n1+s1>.025) & (n2+s2>.025)
    # Require both a NIR decline and corroborating dNBR change. A drop in NIR
    # without a dNBR change is less informative than the combined test.
    base = valid & near_grid & ((n1-n2)>=.033) & (nbr2<.20)
    print('scene coverage in AOI',np.isin(a,[4,5,6])[aoi].mean(),np.isin(b,[4,5,6])[aoi].mean(),valid[aoi].mean(),flush=True)
    for threshold in (.12,.15,.18,.20,.23,.26,.30):
        mask=base & (dnbr>=threshold)
        ids,_=ndi.label(mask)
        big=np.bincount(ids[mask]); keep=np.where(big>=50)[0]
        print(threshold,mask.sum()*.0004,(np.isin(ids,keep)&mask).sum()*.0004,sorted(big.tolist(),reverse=True)[:8],flush=True)
    threshold=.18
    mask=base & (dnbr>=threshold)
    ids,_=ndi.label(mask)
    big=np.bincount(ids[mask])
    mask=mask & np.isin(ids,np.where(big>=50)[0])
    polygons=[shape(g) for g,v in shapes(mask.astype('uint8'),mask=mask,transform=GRID)]
    union=unary_union(polygons)
    print('detections',len(detections),'within 375m',sum(union.distance(p)<=375 for p,_ in detections))
    print('dominant component km2',sorted([p.area/1e6 for p in polygons],reverse=True)[:6])
    cadastral = json.loads((inputs/'native-wfs-u_view.raw').read_text(encoding='utf-8'))
    records = cadastral['features']
    if len(records) != cadastral.get('totalFeatures') or not records:
        raise ValueError('The cadastral extract is empty or truncated')
    parcels=[make_valid(transform(shape(f['geometry']), cad_utm, interleaved=False)).intersection(clip)
             for f in records]
    parcels=[p for p in parcels if p.area>0]
    overlap = union.intersection(unary_union(parcels))
    stats=dict(areaKm2=union.area/1e6,overlapKm2=overlap.area/1e6,
               overlapPercent=overlap.area/union.area*100,intersectingParcels=sum(p.intersection(union).area>0 for p in parcels))
    print(stats,flush=True)

    dest = PROJECT_ROOT / 'web/data/cases/kishkenekol-2025-04-12'
    dest.mkdir(parents=True,exist_ok=True)
    ll_to_web=Transformer.from_crs(4326,3857,always_xy=True)
    min_x,min_y,max_x,max_y=ll_to_web.transform_bounds(*AOI)
    output_width,output_height=850,round(850*(max_y-min_y)/(max_x-min_x))
    output_grid = from_bounds(min_x,min_y,max_x,max_y,output_width,output_height)
    for name, observations in [('before',before_scale),('after',after_scale)]:
        channels=np.zeros((3,output_height,output_width),dtype='float32')
        reproject(observations,channels,src_transform=GRID,src_crs=UTM,src_nodata=0,
                  dst_transform=output_grid,dst_crs='EPSG:3857',resampling=Resampling.bilinear)
        rgb=(255*np.clip(channels.transpose(1,2,0)/.36,0,1)**.82).astype('uint8')
        Image.fromarray(rgb).save(dest/f'{name}.webp',quality=86,method=5)
    stats['bounds']=[[AOI[1],AOI[0]],[AOI[3],AOI[2]]]
    stats['clearPercent']=round(100*valid[aoi].mean(),1)
    stats['parcels']=len(parcels)
    stats['detectionCount']=len(detections)
    stats['nearbyDetections']=sum(union.distance(p)<=375 for p,_ in detections)
    stats['sourceScenes']=[s for day in ('2025-04-06','2025-04-16') for s in scenes(day)]
    geojson(dest/'scar.geojson',[feature(p) for p in polygons])
    geojson(dest/'parcels.geojson',[feature(p, overlapKm2=p.intersection(union).area/1e6) for p in parcels])
    geojson(dest/'detections.geojson',[feature(p,time=t) for p,t in detections])
    (dest/'study.json').write_text(json.dumps(stats,indent=2)+'\n')


if __name__=='__main__':
    parser = argparse.ArgumentParser(description='Rebuild the Sentinel-2 / EGKN Kishkenekol case.')
    parser.add_argument('inputs', type=Path, help='Directory containing Sentinel-2 bands and native cadastral GeoJSON')
    main(parser.parse_args().inputs)
