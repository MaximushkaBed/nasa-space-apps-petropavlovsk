const clone=value=>value==null?value:structuredClone(value);
const radians=Math.PI/180,earthRadius=6371.0088;
const canonical=longitude=>longitude>=-180&&longitude<=180?longitude:((longitude+180)%360+360)%360-180;
const near=(longitude,reference)=>longitude+360*Math.round((reference-longitude)/360);
const descriptions={rectangle:'Прямоугольник: отметьте два противоположных угла.',polygon:'Полигон: добавьте вершины и нажмите «Применить полигон».',circle:'Круг: отметьте центр, затем точку на окружности.'};
const mapDescriptions={rectangle:'Прямоугольник · два противоположных угла.',polygon:'Полигон · добавьте вершины, затем «Применить полигон».',circle:'Круг · центр и точка на окружности.'};

function longitudeParts(ring){
 const clip=(points,edge,greater)=>{const out=[];for(let i=0;i<points.length;i++){const start=points[(i+points.length-1)%points.length],end=points[i],a=greater?start[0]>=edge:start[0]<=edge,b=greater?end[0]>=edge:end[0]<=edge;if(a!==b){const t=(edge-start[0])/(end[0]-start[0]);out.push([edge,start[1]+t*(end[1]-start[1])]);}if(b)out.push(end);}return out;};
 const minimum=Math.min(...ring.map(point=>point[0])),maximum=Math.max(...ring.map(point=>point[0])),polygons=[];
 for(let band=Math.floor((minimum+180)/360);band<=Math.floor((maximum+180)/360);band++){
  const shift=band*360,part=clip(clip(ring,-180+shift,true),180+shift,false);
  if(part.length>=3){const points=part.map(([x,y])=>[x-shift,y]);if(points[0][0]!==points.at(-1)[0]||points[0][1]!==points.at(-1)[1])points.push([...points[0]]);if(points.length>=4)polygons.push([points]);}
 }
 if(!polygons.length)throw new Error('Выделение не образует участок ненулевой площади.');
 return polygons.length===1?{type:'Polygon',coordinates:polygons[0]}:{type:'MultiPolygon',coordinates:polygons};
}

export function circleGeometry(circle){
 const [lon,lat]=circle.center,radius=circle.radius_km;
 if(!Number.isFinite(radius)||radius<.1||radius>2000||Math.abs(lat)>85)throw new Error('Радиус круга должен быть от 0,1 до 2000 км, широта — от −85 до 85°.');
 const p=lat*radians,l=lon*radians,a=radius/earthRadius,ring=[];
 for(let i=0;i<128;i++){const b=2*Math.PI*i/128,y=Math.asin(Math.sin(p)*Math.cos(a)+Math.cos(p)*Math.sin(a)*Math.cos(b)),x=l+Math.atan2(Math.sin(b)*Math.sin(a)*Math.cos(p),Math.cos(a)-Math.sin(p)*Math.sin(y));ring.push([near(x/radians,lon),y/radians]);}
 if(ring.some(([,y])=>Math.abs(y)>85))throw new Error('Круг выходит за доступные широты −85…85°. Уменьшите радиус.');
 return longitudeParts(ring);
}

export function roiGeometry(roi){
 if(roi?.circle)return circleGeometry(roi.circle);
 const geometry=roi?.geometry?.type==='Feature'?roi.geometry.geometry:roi?.geometry;
 if(geometry)return clone(geometry);
 if(!roi?.bbox)return null;
 const [w,s,e,n]=roi.bbox;return {type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]};
}

export function selectionBounds(geometry){
 const points=(geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates).flat(2);
 return points.reduce(([w,s,e,n],[x,y])=>[Math.min(w,x),Math.min(s,y),Math.max(e,x),Math.max(n,y)],[180,85,-180,-85]);
}

export function createAnalysisSelection(root,{map,request,getParent,onCommit,onState,canDraw=()=>true,isActive=()=>true}){
 const $=id=>root.querySelector('#'+CSS.escape(id));
 const preview=L.layerGroup().addTo(map),parentOutline=L.layerGroup().addTo(map);
 let mode=null,points=[],hover=null,parent=null,contextParent=null,pending=false,epoch=0,controller=null,restoreDoubleClick=true;
 const identity=value=>JSON.stringify(value?{geometry:roiGeometry(value),circle:value.circle||null}:null);
 function renderParent(){parentOutline.clearLayers();const roi=mode?parent:contextParent;if(!roi)return;const geometry=roiGeometry(roi);if(geometry)L.geoJSON(geometry,{interactive:false,style:{color:'#9cbbe1',weight:1.5,fillOpacity:0,dashArray:'7 5',opacity:.7}}).addTo(parentOutline);}
 function update(){
  root.dataset.drawMode=mode||'';root.dataset.drawPending=String(pending);
  for(const button of root.querySelectorAll('[data-analysis-shape]')){button.setAttribute('aria-pressed',String(button.dataset.analysisShape===mode));button.disabled=pending;}
  $('selection-actions').hidden=!mode;$('selection-finish').hidden=mode!=='polygon';$('selection-finish').disabled=pending||points.length<3;$('selection-undo').hidden=mode!=='polygon';$('selection-undo').disabled=pending||!points.length;$('selection-cancel').disabled=false;
  $('draw-instruction').hidden=!mode;map.getContainer().style.cursor=mode?'crosshair':'';
  $('draw-instruction').textContent=mode?`${pending?'Применяем точную границу…':mapDescriptions[mode]}${parent?' Внутри: '+parent.name+'.':''} Esc — отмена.`:'';
  $('selection-state').textContent=mode?pending?'Проверяем пересечение с выбранной территорией…':`${descriptions[mode]}${parent?' Только внутри «'+parent.name+'».':''}`:'Выберите инструмент. Граница изменится после завершения выделения.';
  onState?.({active:Boolean(mode),pending,mode});
 }
 function draw(){
  preview.clearLayers();if(!mode)return;
  const style={color:'#ffd288',weight:2,fillColor:'#f3b858',fillOpacity:.14,interactive:false};
  for(const point of points)L.circleMarker(point,{...style,radius:4,fillOpacity:1,color:'#fff0c8'}).addTo(preview);
  if(mode==='rectangle'&&points[0]&&hover)L.rectangle([points[0],hover],style).addTo(preview);
  else if(mode==='circle'&&points[0]&&hover){const radius=map.distance(points[0],hover);L.circle(points[0],{...style,radius}).addTo(preview);$('selection-measure').textContent=`Радиус: ${(radius/1000).toLocaleString('ru',{maximumFractionDigits:2})} км`;}
  else if(mode==='polygon'&&points.length){const outline=hover?[...points,hover]:points;if(outline.length>=3)L.polygon(outline,style).addTo(preview);else if(outline.length>1)L.polyline(outline,style).addTo(preview);$('selection-measure').textContent=`Вершин: ${points.length}`;}
 }
 function cancel({focus=false}={}){
  ++epoch;controller?.abort();controller=null;mode=null;points=[];hover=null;pending=false;preview.clearLayers();$('selection-measure').textContent='';if(restoreDoubleClick)map.doubleClickZoom.enable();renderParent();update();if(focus)$('draw-area').focus({preventScroll:true});
 }
 function start(next='polygon'){
  if(!canDraw()||!isActive())return;
  if(mode===next&&!pending){cancel();return;}cancel();mode=next;parent=clone(getParent());restoreDoubleClick=map.doubleClickZoom.enabled();map.doubleClickZoom.disable();document.dispatchEvent(new CustomEvent('nasa:analysis-drawing',{detail:{active:true}}));renderParent();update();map.getContainer().focus({preventScroll:true});map.getContainer().scrollIntoView({block:'center'});
 }
 function candidate(){
  if(mode==='polygon'){
   if(points.length<3)throw new Error('Добавьте минимум три вершины.');
   const ring=[];for(const point of points)ring.push([ring.length?near(point.lng,ring.at(-1)[0]):canonical(point.lng),point.lat]);
   return {geometry:longitudeParts(ring),name:'Полигональный участок'};
  }
  if(points.length<2)throw new Error('Отметьте две точки на карте.');
  if(mode==='circle'){const circle={center:[canonical(points[0].lng),points[0].lat],radius_km:map.distance(points[0],points[1])/1000};return {geometry:circleGeometry(circle),circle,name:`Круг ${circle.radius_km.toLocaleString('ru',{maximumFractionDigits:2})} км`};}
  const a=points[0],b=points[1],w=canonical(a.lng),e=near(b.lng,w),south=Math.min(a.lat,b.lat),north=Math.max(a.lat,b.lat);
  return {geometry:longitudeParts([[Math.min(w,e),south],[Math.max(w,e),south],[Math.max(w,e),north],[Math.min(w,e),north]]),name:'Прямоугольный участок'};
 }
 async function finish(){
  if(!mode||pending)return;
  let shape;try{shape=candidate();}catch(error){if(mode!=='polygon'){points=points.slice(0,1);hover=null;draw();}update();$('selection-state').textContent=$('draw-instruction').textContent=error.message;return;}
  const current=++epoch,intended=identity(parent);controller=new AbortController();pending=true;update();
  try{
   const clipped=await request('/api/v1/geometry/clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parent:parent?roiGeometry(parent):shape.geometry,geometry:shape.geometry}),signal:controller.signal});
   if(current!==epoch||!isActive()||identity(getParent())!==intended)return;
   if(!clipped.geometry||!clipped.bbox)throw new Error('Сервис не вернул точную границу участка.');
   const roi={preset:'custom',name:parent?`${shape.name} · ${parent.name}`:shape.name,bbox:clipped.bbox,source:parent?'Выделение внутри '+parent.name:'Выделение на карте',...(shape.circle&&!clipped.clipped?{circle:shape.circle}:{geometry:clipped.geometry})};
   await onCommit(roi,{parent:clone(parent),clipped:clipped.clipped});if(current!==epoch)return;
   cancel();$('selection-state').textContent=clipped.clipped?'Участок применён по точному пересечению с границей территории.':'Граница участка применена.';
  }catch(error){if(current!==epoch||error.name==='AbortError')return;pending=false;if(mode!=='polygon'){points=points.slice(0,1);hover=null;draw();}update();const message=`Участок не применён: ${error.message} Измените выделение или отмените его.`;$('selection-state').textContent=message;$('draw-instruction').textContent=message;}
  finally{if(current===epoch){pending=false;controller=null;}}
 }
 function undo(){if(mode!=='polygon'||pending)return;points.pop();draw();update();}
 for(const button of root.querySelectorAll('[data-analysis-shape]'))button.addEventListener('click',()=>start(button.dataset.analysisShape));
 $('refine-area').addEventListener('click',()=>start('polygon'));$('selection-cancel').addEventListener('click',()=>cancel({focus:true}));$('selection-finish').addEventListener('click',finish);$('selection-undo').addEventListener('click',undo);
 map.on('click',event=>{if(!mode||pending||!isActive())return;hover=event.latlng;points.push(event.latlng);draw();update();if(mode!=='polygon'&&points.length===2)finish();});
 map.on('mousemove',event=>{if(!mode||pending)return;hover=event.latlng;draw();});
 root.addEventListener('keydown',event=>{if(event.key==='Escape'&&mode){event.preventDefault();cancel({focus:true});}else if(mode&&event.target===map.getContainer()&&['Backspace','Delete'].includes(event.key)){event.preventDefault();undo();}else if(mode==='polygon'&&event.target===map.getContainer()&&event.key==='Enter'){event.preventDefault();finish();}});
 update();
 return {start,cancel,get active(){return Boolean(mode);},get pending(){return pending;},setContextParent(roi){contextParent=clone(roi);if(!mode)renderParent();},clearContext(){contextParent=null;cancel();}};
}
