"""Bounded WGS84 study geometries shared by map and numerical queries."""
import json
import math


def circle_polygon(circle):
    if not isinstance(circle,dict) or not isinstance(circle.get('center'),list) or len(circle['center'])!=2:
        raise ValueError('Круг: укажите center=[долгота,широта] и radius_km.')
    lon,lat=circle['center'];radius=circle.get('radius_km')
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in [lon,lat,radius]):
        raise ValueError('Координаты и радиус должны быть конечными числами.')
    if not (-180<=lon<=180 and -85<=lat<=85 and .1<=radius<=2000):
        raise ValueError('Радиус круга: 0,1–2000 км; координаты внутри доступной карты.')
    ring=[];p=math.radians(lat);l=math.radians(lon);a=radius/6371.0088
    for i in range(128):
        b=2*math.pi*i/128
        y=math.asin(math.sin(p)*math.cos(a)+math.cos(p)*math.sin(a)*math.cos(b))
        x=l+math.atan2(math.sin(b)*math.sin(a)*math.cos(p),math.cos(a)-math.sin(p)*math.sin(y))
        x=math.degrees(x);x+=360*round((lon-x)/360)
        ring.append([x,math.degrees(y)])
    if any(abs(y)>85 for x,y in ring):raise ValueError('Выделение выходит за широты −85…85°.')
    # Clip an unwrapped ring into longitude bands, preserving dateline circles.
    def clip(points,edge,keep_greater):
        out=[]
        for start,end in zip(points[-1:]+points[:-1],points):
            inside_a=(start[0]>=edge) if keep_greater else (start[0]<=edge)
            inside_b=(end[0]>=edge) if keep_greater else (end[0]<=edge)
            if inside_a!=inside_b:
                t=(edge-start[0])/(end[0]-start[0]);out.append([edge,start[1]+t*(end[1]-start[1])])
            if inside_b:out.append(end)
        return out
    polygons=[]
    for shift in [-360,0,360]:
        part=clip(clip(ring,-180+shift,True),180+shift,False)
        if len(part)>=3:
            points=[[x-shift,y] for x,y in part];points.append(points[0]);polygons.append([points])
    return {'type':'Polygon','coordinates':polygons[0]} if len(polygons)==1 else {'type':'MultiPolygon','coordinates':polygons}


def normalize_geometry(value,connection):
    if not isinstance(value,dict) or value.get('type') not in ('Polygon','MultiPolygon'):
        raise ValueError('Передайте GeoJSON Polygon или MultiPolygon.')
    polygons=[value.get('coordinates')] if value['type']=='Polygon' else value.get('coordinates')
    if not isinstance(polygons,list) or not polygons:raise ValueError('Пустая геометрия территории.')
    count=0;positions=[];normalized=[]
    for polygon in polygons:
        if not isinstance(polygon,list) or not polygon:raise ValueError('Пустой полигон.')
        rings=[]
        for ring in polygon:
            if not isinstance(ring,list) or len(ring)<4:raise ValueError('Кольцо должно содержать минимум четыре координаты.')
            result=[]
            for point in ring:
                count+=1
                if count>20000:raise ValueError('В выделении допустимо не более 20000 вершин.')
                if not isinstance(point,list) or len(point)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in point):
                    raise ValueError('Координата GeoJSON: [долгота, широта], два конечных числа.')
                x,y=point
                if not (-180<=x<=180 and -85<=y<=85):raise ValueError('Геометрия выходит за границы карты.')
                result.append([float(x),float(y)]);positions.append((x,y))
            if result[0]!=result[-1]:raise ValueError('Кольца GeoJSON должны быть замкнуты.')
            rings.append(result)
        normalized.append(rings)
    geometry={'type':value['type'],'coordinates':normalized[0] if value['type']=='Polygon' else normalized}
    con=connection(memory='96MB')
    try:
        valid,area=con.execute("SELECT ST_IsValid(g),ST_Area(ST_Transform(g,'OGC:CRS84','EPSG:6933',always_xy:=true)) FROM (SELECT ST_GeomFromGeoJSON(?) g)",[json.dumps(geometry)]).fetchone()
    finally:con.close()
    if not valid or not area or area<1:raise ValueError('Нужен корректный полигон ненулевой площади без самопересечений.')
    if area>25_000_000*1e6:raise ValueError('Для детального анализа выберите территорию меньше 25 млн км².')
    bbox=[min(p[0] for p in positions),min(p[1] for p in positions),max(p[0] for p in positions),max(p[1] for p in positions)]
    return geometry,bbox
