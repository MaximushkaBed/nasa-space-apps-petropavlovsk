/* Scientific query identity. Display labels and the selected display platform are not filters. */
const number=value=>typeof value==='number'&&Number.isFinite(value);
const rounded=value=>{const result=Math.round(value*1e5)/1e5;return Object.is(result,-0)?0:result;};
const geometryOf=config=>config.geometry?.type==='Feature'?config.geometry.geometry:config.geometry;
function geometryKey(geometry){
 if(!geometry)return null;
 if(!['Polygon','MultiPolygon'].includes(geometry.type)||!Array.isArray(geometry.coordinates))throw new TypeError('Invalid scientific geometry');
 const coordinates=value=>{if(!Array.isArray(value))throw new TypeError('Invalid scientific coordinates');return value.map(item=>Array.isArray(item)?coordinates(item):number(item)?item:(()=>{throw new TypeError('Invalid scientific coordinate');})());};
 return {type:geometry.type,coordinates:coordinates(geometry.coordinates)};
}
function core(config){
 if(!config||!Array.isArray(config.bbox)||config.bbox.length!==4||!config.bbox.every(number))throw new TypeError('Scientific config requires finite bbox');
 const result={preset:config.preset||'custom',bbox:config.bbox.map(rounded),start:config.start,end:config.end,baseline_start:Number(config.baseline_start),baseline_end:Number(config.baseline_end),grid_km:Number(config.grid_km??10),quality:config.quality||'sp',daynight:config.daynight||'all'};
 const validGrid=result.preset==='world'?result.grid_km===250:[2,5,10,20].includes(result.grid_km);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(result.start||'')||!/^\d{4}-\d{2}-\d{2}$/.test(result.end||'')||!Number.isInteger(result.baseline_start)||!Number.isInteger(result.baseline_end)||!validGrid||!['sp','all'].includes(result.quality)||!['all','D','N'].includes(result.daynight))throw new TypeError('Invalid scientific filters');
 return result;
}
export function scientificSignature(config){
 const result=core(config);
 if(result.preset==='sko')return JSON.stringify({...result,shape:'canonical-sko'});
 if(config.circle){const {center,radius_km}=config.circle;if(!Array.isArray(center)||center.length!==2||!center.every(number)||!number(radius_km))throw new TypeError('Invalid scientific circle');result.shape={circle:{center:[...center],radius_km}};}
 else result.shape=geometryKey(geometryOf(config));
 return JSON.stringify(result);
}
export function sameScientificConfig(a,b){
 try{
  if(scientificSignature(a)!==scientificSignature(b))return false;
  // SKO is a canonical server-owned region. When both sides carry it, verify the full shape too.
  if(a.preset==='sko'&&geometryOf(a)&&geometryOf(b))return JSON.stringify(geometryKey(geometryOf(a)))===JSON.stringify(geometryKey(geometryOf(b)));
  return true;
 }catch{return false;}
}
