import {createAreaLayerClip} from './area-layer-clip.js';
import {localizeTree,numberFormat,translate} from './i18n.js';

const panes=['territory-context-reference','territory-context-boundaries','territory-context-labels'];
const referenceURL='https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const referenceAttribution='Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community';
let sequence=0;
const near=(longitude,center)=>longitude+360*Math.round((center-longitude)/360);
const geometryOf=roi=>{const geometry=roi?.geometry?.type==='Feature'?roi.geometry.geometry:roi?.geometry;if(geometry)return geometry;if(!roi?.bbox)return null;const[w,s,e,n]=roi.bbox;return{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]};};
const shapeKey=roi=>roi?JSON.stringify(roi.circle?{circle:roi.circle}:{geometry:geometryOf(roi)}):null;
function inRing(ring,longitude,latitude){const reference=ring[0][0],x=near(longitude,reference);let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const[a,y]=ring[i],[b,z]=ring[j],ax=near(a,reference),bx=near(b,reference);if((y>latitude)!==(z>latitude)&&x<(bx-ax)*(latitude-y)/(z-y)+ax)inside=!inside;}return inside;}
function contains(roi,[longitude,latitude]){
 if(roi.circle){const [x,y]=roi.circle.center,r=Math.PI/180,a=(latitude-y)*r,b=(longitude-x)*r,value=Math.sin(a/2)**2+Math.cos(y*r)*Math.cos(latitude*r)*Math.sin(b/2)**2;return 6371.0088*2*Math.asin(Math.min(1,Math.sqrt(value)))<=roi.circle.radius_km;}
 const geometry=geometryOf(roi);if(!geometry)return false;const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;return polygons.some(([outer,...holes])=>inRing(outer,longitude,latitude)&&!holes.some(hole=>inRing(hole,longitude,latitude)));
}
const make=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};

// Cartographic context only. It never changes a selected boundary or creates an
// analysis; uncut child previews are masked by the caller's exact study shape.
export function createTerritoryContext(map,control){
 const serial=++sequence,clipId=`territory-context-clip-${serial}`;
 panes.forEach((name,index)=>{const pane=map.getPane(name)||map.createPane(name);pane.style.zIndex=String(411+index*8);pane.style.pointerEvents='none';});
 const mask=createAreaLayerClip(map,{panes,id:clipId}),boundaries=L.layerGroup(),labels=L.layerGroup(),format=numberFormat({maximumFractionDigits:0});
 control.classList.add('territory-context-control');control.hidden=true;
 control.innerHTML=`<label class="territory-context-toggle"><input type="checkbox" data-territory-context-toggle checked><span>Границы и названия</span></label><p class="territory-context-legend"><i class="context-primary-line"></i><span>Основная граница</span><i class="context-child-line"></i><span>Границы частей</span></p><p class="territory-context-status" data-context-status role="status" aria-live="polite"></p><details class="territory-context-sources"><summary>Источники и статус</summary><p data-context-sources></p><p data-context-coverage></p><p>Справочная картография Esri; подпись города не задаёт его административную границу.</p></details>`;
 const checkbox=control.querySelector('[data-territory-context-toggle]'),status=control.querySelector('[data-context-status]');
 let roi=null,key=null,data=null,enabled=true,paused=false,loading=false,epoch=0,abort=null,loader=null,reference=null,referenceFailed=false,lastBand=null;
 function cancel(){++epoch;abort?.abort();abort=null;loading=false;}
 function hide(){boundaries.remove();labels.remove();reference?.remove();}
 function renderControl(){
  control.hidden=!roi;checkbox.checked=enabled;map.getContainer().dataset.territoryContextSelected=String(Boolean(roi));map.getContainer().dataset.territoryContext=roi&&enabled&&!paused?'on':'off';
  const count=(data?.items||[]).filter(item=>item.previewGeometry).length;
  status.textContent=!enabled?'Контекст территории скрыт.':loading?'Загружаем границы частей территории…':referenceFailed?'Часть справочных подписей Esri не загрузилась.':count?`Границы каталога: ${format.format(count)}. Названия мест: Esri.`:'Границы каталога недоступны. Показана справочная картография Esri.';
  control.querySelector('[data-context-sources]').textContent=[...new Set((data?.items||[]).map(item=>item.source).filter(Boolean)),'Esri · HERE · Garmin · OpenStreetMap'].join(' · ');
  control.querySelector('[data-context-coverage]').textContent=data?.coverage?.message||'';localizeTree(control);
 }
 function drawLabels(){
  labels.clearLayers();if(!roi||!enabled||paused)return;
  const occupied=[],size=map.getSize(),center=map.getCenter().lng;
  for(const item of data?.items||[]){const point=item.labelPoint;if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||!contains(roi,point))continue;
   const latlng=L.latLng(point[1],near(point[0],center)),position=map.latLngToContainerPoint(latlng),name=translate(item.label||item.name||'');
   if(position.x<0||position.x>size.x||position.y<0||position.y>size.y)continue;
   const width=Math.min(148,Math.max(42,name.length*6.1)),height=name.length>22?30:18,box={x:position.x-width/2,y:position.y-height/2,w:width,h:height};
   if(occupied.some(other=>box.x<other.x+other.w+6&&box.x+box.w+6>other.x&&box.y<other.y+other.h+5&&box.y+box.h+5>other.y))continue;occupied.push(box);
   const text=make('span','',item.label||item.name||'');localizeTree(text);L.marker(latlng,{interactive:false,keyboard:false,pane:panes[2],icon:L.divIcon({className:'territory-context-label',html:text,iconSize:[0,0],iconAnchor:[0,0]})}).addTo(labels);
  }
 }
 function drawBoundaries(){
  boundaries.clearLayers();if(!roi||!enabled||paused)return;const center=map.getCenter().lng;lastBand=Math.round(center/360);
  for(const item of data?.items||[])if(item.previewGeometry)L.geoJSON(item.previewGeometry,{pane:panes[1],interactive:false,coordsToLatLng:([x,y])=>L.latLng(y,near(x,center)),style:{color:'#b3c8dc',weight:1,opacity:.78,fill:false}}).addTo(boundaries);
 }
 function ensureReference(){
  if(reference||!roi)return;
  const box=roi.bbox&&[...roi.bbox];if(box&&(box[0]<-180||box[2]>180||box[0]>box[2])){box[0]=-180;box[2]=180;}
  reference=L.tileLayer(referenceURL,{pane:panes[0],maxNativeZoom:23,maxZoom:23,opacity:.85,crossOrigin:'anonymous',bounds:box?[[box[1],box[0]],[box[3],box[2]]]:undefined,attribution:referenceAttribution});
  const layer=reference;layer.on('tileerror',()=>{if(reference!==layer||paused||!enabled||!roi)return;referenceFailed=true;renderControl();});
 }
 function render(){
  mask.select(roi?roi.circle?{circle:roi.circle}:{geometry:geometryOf(roi)}:null);renderControl();
  if(!roi||!enabled||paused){hide();return;}ensureReference();reference.addTo(map);boundaries.addTo(map);labels.addTo(map);drawBoundaries();drawLabels();mask.update();
 }
 async function select(next,options={}){
  const nextKey=shapeKey(next),changed=nextKey!==key;
  if(changed){cancel();hide();reference=null;referenceFailed=false;roi=next?structuredClone(next):null;key=nextKey;data=null;enabled=Boolean(roi);loader=null;}
  else if(next)roi=structuredClone(next);
  if(options.load)loader=options.load;
  if(Object.hasOwn(options,'data')){data=options.data;loading=false;}
  else if(options.loading&&!data)loading=true;
  if(!roi){render();return;}
  if(loader&&!data&&!loading&&!paused){loading=true;abort=new AbortController();const current=epoch,intended=key;render();try{const result=await loader({signal:abort.signal});if(current!==epoch||intended!==key||paused)return;data=result;loading=false;render();}catch(error){if(current!==epoch||error.name==='AbortError'||paused)return;data={items:[],coverage:{message:'Границы частей территории временно недоступны.'}};loading=false;render();}finally{if(current===epoch)abort=null;}return;}
  render();
 }
 checkbox.addEventListener('change',()=>{enabled=checkbox.checked;render();});
 map.on('moveend zoomend resize',()=>{if(!roi||!enabled||paused)return;if(lastBand!==Math.round(map.getCenter().lng/360))drawBoundaries();drawLabels();mask.update();});
 localizeTree(control);
 return {select,pause(){paused=true;cancel();hide();renderControl();},resume(){paused=false;if(roi)select(roi);},getState:()=>({enabled}),setEnabled(value){if(typeof value==='boolean'){enabled=value;render();}}};
}
