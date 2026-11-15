import { dateFormat, localizeTree, numberFormat, setLocalizedInputValue, translate } from './i18n.js';
import { mountMatrixPanel } from './matrix-panel.js?v=dark';
import { sameScientificConfig, scientificSignature } from './scientific-context.js';
import { mountStudyPlanner } from './study-planner.js';
import { mountStudyRevisions } from './study-revisions.js';
import { createTerritorySearch, fitTerritory } from './territory-search.js';

export function mountWorkbench(root, bridge={}) {
if (!(root instanceof Element)) throw new TypeError('Workbench root is required');
root.classList.add('analysis-workbench');
root.dataset.bootstrapPending='true';
const $ = (id) => root.querySelector('#'+CSS.escape(id));
const ns = 'http://www.w3.org/2000/svg';
const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const longMonths = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const labels = {'Aqua':'Aqua / MODIS','Terra':'Terra / MODIS','Suomi-NPP':'Suomi-NPP / VIIRS','NOAA-20':'NOAA-20 / VIIRS','NOAA-21':'NOAA-21 / VIIRS'};
const num = numberFormat({ maximumFractionDigits:1 });
let settings, result, jobId, source='NOAA-20', view='calendar', step='month', month, generation=0, mapGeneration=0;
let drawStart=null, drawing=false, roiLayer, cellsLayer, frame=0, playing=false, busy=false;
let mapMode='activity', mapYear=null, compareYearA=null, compareYearB=null;
let active=false, settingsPromise, pendingAnalysis, activation=0, pendingViewState=null;
let analysisAbort=null,pendingQuestionNavigation=false,bootstrapPending=true;
let roiGeometry=null, roiCircle=null, roiName='', roiSource='', retainedFocus=null, rangeFocus=null;
let territorySelected=false, territoryRevision=0, territoryTimer;
const clone=value=>value==null?value:structuredClone(value);
const monthFormat = dateFormat({ month: 'long', year: 'numeric', timeZone: 'UTC' });
const formatMonth = (key) => monthFormat.format(new Date(`${key}-01`));
const n = (value) => value===null || value===undefined ? '—' : num.format(value);
const map = L.map($('analysis-map'), {preferCanvas:true, minZoom:1, maxZoom:17, worldCopyJump:false}).setView([18,0],1);
map.attributionControl.setPrefix(false);
const land = L.tileLayer('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg', {maxNativeZoom:8,maxZoom:17,noWrap:true,attribution:'NASA GIBS'}).addTo(map);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:17,attribution:'Esri World Imagery · дата мозаики не равна дате детекций'});
cellsLayer=L.layerGroup().addTo(map);
new ResizeObserver(()=>{if(active)map.invalidateSize({pan:false});}).observe($('analysis-map'));
const matrixPanel=mountMatrixPanel($('matrix-panel'),{request,bridge,getAnalysis:()=>result&&jobId?{id:jobId,result,platform:source,context:getState().context}:null});
const planner=mountStudyPlanner(root,{request,getInput:()=>({config:formConfig(),platform:source,focus:clone(retainedFocus)}),validate:validateInputs,isActive:()=>active,
 applyOption:option=>{source=option.platform;$('platform').value=source;syncCanonicalConfig(option.config);if(retainedFocus&&(retainedFocus.start<option.config.start||retainedFocus.end>option.config.end)){retainedFocus=null;rangeFocus=null;}invalidate({keepStudy:true});publishContext();},
 onPlanning:()=>{showResultSurface(false);$('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=true;},
 onExistingResult:()=>{if(result&&source!=='all'&&sameScientificConfig(result.config,formConfig())){showResultSurface(true);$('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=false;renderAll();planner.resultReady({id:jobId,platform:source,month});}},
 onQuestion:(tab,action)=>{if(action?.invalidate){pendingQuestionNavigation=true;if(result&&source!=='all'&&sameScientificConfig(result.config,formConfig())){showResultSurface(true);$('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=false;planner.resultReady({id:jobId,platform:source,month},{navigate:true});pendingQuestionNavigation=false;}else if(!result)invalidate();publishContext();}else if(tab)activateTab(tab);},onChange:publishContext});
const revisions=mountStudyRevisions($('study-revisions'),{request,isActive:()=>active,getAnalysis:()=>result&&jobId&&source!=='all'?{id:jobId,result,platform:source,question:planner.getState().question,month,seriesMode:$('series-mode').value,years:[compareYearA,compareYearB]}:null,onChange:publishContext,
 onShare:pair=>bridge.navigate?.('analysis',{share:true,state:{...getState(),revisions:pair,shareRevisions:true}}),
 onArchive:()=>{$('analysis-area-title').textContent='Сравнение сохранённых расчётов';$('context-note').textContent='Архивные значения показаны ниже. Новый расчёт не запускался.';$('study-next-title').textContent='Архивное сравнение';$('study-next-note').textContent='Текущий анализ этой версии не восстановлен. Сохранённые числа и ограничения доступны в сравнении выше.';}});
showResultSurface(false);
setBootstrapPending(true);
const territorySearch=createTerritorySearch(request,()=>settings?.region_geometry||request('data/region.geojson').then(value=>value.features?.[0]?.geometry||value.geometry||value));
for(const id of ['run','study-plan-request'])new MutationObserver(()=>{if(!territorySelected&&!$(id).disabled)$(id).disabled=true;}).observe($(id),{attributes:true,attributeFilter:['disabled']});

function svgElement(tag, attrs={}, text){const node=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,v));if(text!==undefined)node.textContent=text;return node;}
function empty(id,text){const node=document.createElement('div');node.className='empty-state';const p=document.createElement('p');p.textContent=text;node.append(p);$(id).replaceChildren(node);}
async function request(url, options={}){
 const response=await fetch(url,options);let body;
 try{body=await response.json();}catch{const error=new Error('Сервис временно не отвечает. Повторите запрос.');error.status=response.status;throw error;}
 if(!response.ok){const error=new Error(body.error||`HTTP ${response.status}`);error.status=response.status;throw error;}
 return body;
}
function formConfig(){return {preset:$('preset').value,bbox:['west','south','east','north'].map(k=>Number($(k).value)),start:$('start').value,end:$('end').value,baseline_start:Number($('baseline-start').value),baseline_end:Number($('baseline-end').value),grid_km:Number($('grid').value),quality:$('include-nrt').checked?'all':'sp',daynight:$('daynight').value,...(roiGeometry?{geometry:clone(roiGeometry)}:{}),...(roiCircle?{circle:clone(roiCircle)}:{}),...(roiName?{roi_name:roiName}:{}),...(roiSource?{roi_source:roiSource}:{})};}
function selectedPreset(){return settings?.presets.find(p=>p.id===$('preset').value);}
function validateInputs(){
 if(bootstrapPending){$('form-status').textContent='Дождитесь подключения к архиву.';return false;}
 if(!territorySelected){$('form-status').textContent='Сначала найдите территорию или выделите область на карте.';$('analysis-territory-query').focus();return false;}
 const form=$('analysis-form');
 for(const input of form.querySelectorAll('input'))input.setCustomValidity('');
 const config=formConfig();
 if(config.start>config.end)$('end').setCustomValidity('Конец истории должен быть не раньше начала.');
 if(config.baseline_start>config.baseline_end)$('baseline-end').setCustomValidity('Последний базовый год должен быть не раньше первого.');
 if(config.baseline_start<Number(config.start.slice(0,4))||config.baseline_end>Number(config.end.slice(0,4)))$('baseline-start').setCustomValidity('Базовые годы должны входить в выбранную историю.');
 if(config.bbox[0]>=config.bbox[2])$('east').setCustomValidity('Восточная граница должна быть восточнее западной.');
 if(config.bbox[1]>=config.bbox[3])$('north').setCustomValidity('Северная граница должна быть севернее южной.');
 if(!form.checkValidity()){
  if([...$('manual-conditions').querySelectorAll('input,select')].some(input=>!input.validity.valid))$('manual-conditions').open=true;
  if([...$('coordinate-details').querySelectorAll('input')].some(input=>!input.validity.valid))$('coordinate-details').open=true;
  form.reportValidity();$('form-status').textContent='Проверьте отмеченные условия исследования.';return false;
 }
 try{scientificSignature(config);}catch{$('form-status').textContent='Задайте допустимую территорию, историю и фильтры.';return false;}
 return true;
}
function areaName(config){if(!territorySelected)return 'Выберите территорию';return (config.preset==='sko'?settings?.presets.find(p=>p.id==='sko')?.name:config.roi_name)||settings?.presets.find(p=>p.id===config.preset&&p.id!=='custom')?.name || `Область ${config.bbox[1].toFixed(2)}°, ${config.bbox[0].toFixed(2)}°` ;}
function syncTerritoryControls(){
 root.dataset.territorySelected=String(territorySelected);
 $('analysis-territory-selected').textContent=territorySelected?areaName(formConfig()):'Территория пока не выбрана';
 $('run').disabled=$('study-plan-request').disabled=bootstrapPending||busy||!territorySelected;
}
function cancelTerritorySearch(){++territoryRevision;clearTimeout(territoryTimer);$('analysis-territory-results').replaceChildren();$('analysis-territory-results').hidden=true;$('analysis-territory-query').setAttribute('aria-expanded','false');}
async function searchTerritory(){
 clearTimeout(territoryTimer);const text=$('analysis-territory-query').value.trim();cancelTerritorySearch();
 if(text.length<2){$('analysis-territory-status').textContent='Введите хотя бы две буквы названия.';return;}
 const revision=territoryRevision;$('analysis-territory-status').textContent='Поиск границ…';
 try{
  const matches=await territorySearch.search(text);if(revision!==territoryRevision||!active)return;
  const results=$('analysis-territory-results');
  for(const match of matches){
   const button=document.createElement('button');button.type='button';button.role='option';button.textContent=match.label;
   button.addEventListener('click',async()=>{
    if(revision!==territoryRevision)return;$('analysis-territory-status').textContent='Загружаем точную границу…';
    try{
     const roi=await match.load();if(revision!==territoryRevision||!active)return;
     territorySelected=true;clearShape();$('preset').value=roi.preset||'custom';roiGeometry=clone(roi.geometry)||null;roiCircle=clone(roi.circle)||null;roiName=roi.name;roiSource=roi.source;
     ['west','south','east','north'].forEach((key,i)=>$(key).value=roi.bbox[i]);
     cancelTerritorySearch();setLocalizedInputValue($('analysis-territory-query'),roi.name);$('analysis-territory-status').textContent=roi.source;
     drawing=false;drawStart=null;$('draw-instruction').hidden=true;map.getContainer().style.cursor='';showBounds(false);if(roiGeometry)fitTerritory(map,roiGeometry);else showBounds();invalidate();publishContext();
    }catch(error){if(revision===territoryRevision)$('analysis-territory-status').textContent='Не удалось загрузить границу. Повторите поиск или выделите область на карте.';}
   });results.append(button);
  }
  results.hidden=!matches.length;$('analysis-territory-query').setAttribute('aria-expanded',String(Boolean(matches.length)));
  $('analysis-territory-status').textContent=matches.length?'Выберите территорию из списка.':'Место не найдено. Уточните название или выделите область на карте.';
 }catch(error){if(revision===territoryRevision)$('analysis-territory-status').textContent='Поиск недоступен. Повторите запрос или выделите область на карте.';}
}
function showBounds(fit=true){
  if(roiLayer)roiLayer.remove();roiLayer=null;syncTerritoryControls();
  if(!territorySelected){if(fit)map.setView([18,0],1,{animate:false});$('area-note').textContent='Найдите территорию или выделите область на карте.';return;}
  const bbox=formConfig().bbox;
  if($('preset').value==='sko'&&(roiGeometry||settings?.region_geometry))roiLayer=L.geoJSON(roiGeometry||settings.region_geometry,{style:{color:'#8bc6ff',weight:1.8,fillOpacity:.04}}).addTo(map);
  else if(roiCircle)roiLayer=L.circle([roiCircle.center[1],roiCircle.center[0]],{radius:roiCircle.radius_km*1000,color:'#8bc6ff',weight:1.8,fillOpacity:.04}).addTo(map);
  else if(roiGeometry)roiLayer=L.geoJSON(roiGeometry,{style:{color:'#8bc6ff',weight:1.8,fillOpacity:.04}}).addTo(map);
  else roiLayer=L.rectangle([[bbox[1],bbox[0]],[bbox[3],bbox[2]]],{color:'#8bc6ff',weight:1.8,fillOpacity:.04}).addTo(map);
  if(fit){if(roiGeometry)fitTerritory(map,roiGeometry);else map.fitBounds(roiLayer.getBounds(),{padding:[35,35],maxZoom:8});}
  $('area-note').textContent=$('preset').value==='sko'?'Анализ по исходной границе СКО, не по прямоугольнику.':roiGeometry?'Анализ по переданной геометрии территории; прямоугольник показывает только её охват.':roiCircle?`Анализ по окружности радиусом ${n(roiCircle.radius_km)} км.`:'Анализ по выделенному прямоугольнику; административные границы могут отличаться.';
}
function clearShape(){roiGeometry=roiCircle=null;roiName=roiSource='';}
function publishContext(){if(active)bridge.setContext?.(getState().context);}
function setPreset(){cancelTerritorySearch();territorySelected=true;clearShape();const p=selectedPreset();if(p)['west','south','east','north'].forEach((k,i)=>$(k).value=p.bbox[i]);showBounds();invalidate();publishContext();}
function showResultSurface(value){root.dataset.hasResult=String(value);$('study-results').hidden=!value;$('study-next-step').hidden=value;root.querySelector('.insights').hidden=!value;root.querySelector('.timeline-bar').hidden=!value;$('study-revisions').hidden=!value;}
function invalidate({keepStudy=false}={}){
  ++generation;analysisAbort?.abort();analysisAbort=null;if(busy)setBusy(false);
  if(!keepStudy)planner.invalidate();showResultSurface(false);
  revisions.clear();
  $('error-banner').hidden=true;
  matrixPanel.reset();
  result=null;jobId=null;++mapGeneration;mapYear=null;cellsLayer.clearLayers();$('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=true;
  $('focus-month').disabled=true;$('focus-month').replaceChildren(new Option('Сначала построить анализ',''));
  ['activity-value','baseline-value','anomaly-value','season-months'].forEach(id=>$(id).textContent='—');
  $('points-value').textContent='Нет рассчитанных данных для текущих параметров.';$('anomaly-context').textContent='Постройте анализ выбранной территории для сравнения с историей.';$('reference-disagreement').textContent='';
  $('activity-unit').textContent=`ячейко-дни · сетка ${$('grid').value} км`;$('map-key-text').textContent='Карта текущих параметров ещё не рассчитана.';
  $('series-caption').textContent='Нет рассчитанного временного ряда.';$('seasonal-caption').textContent='Сезонный профиль появится после расчёта.';$('validation-note').textContent='Проверка относится к рассчитанным параметрам.';$('compare-caption').textContent='Сравнение лет появится после расчёта выбранной территории.';$('provenance-details').textContent='Для текущих параметров готовый расчёт не выбран.';
  $('context-note').textContent='Параметры изменены. Постройте анализ выбранной области.';
  $('analysis-area-title').textContent=areaName(formConfig());$('map-period').textContent='Область исследования';$('map-count').textContent='';
  $('retry-map').hidden=true;
  ['series-chart','season-chart','calendar-season-chart','validation-chart','compare-chart'].forEach(id=>empty(id,'Запустите анализ с выбранными параметрами.'));
  $('calendar-grid').replaceChildren();$('validation-summary').replaceChildren();$('compare-metrics').replaceChildren();$('compare-year-a').disabled=$('compare-year-b').disabled=$('compare-map-a').disabled=$('compare-map-b').disabled=true;$('reference-disagreement').hidden=true;stopPlaying();
  renderFocusScope();
  syncTerritoryControls();
}
function setBootstrapPending(value){bootstrapPending=value;root.dataset.bootstrapPending=String(value);$('analysis-form').setAttribute('aria-busy',String(value));syncTerritoryControls();root.querySelectorAll('#analysis-form fieldset').forEach(field=>field.disabled=value||busy);if(value){$('form-status').textContent='Подключаем сведения об архиве…';$('study-plan-status').textContent='Загружаем настройки. Территория будет сохранена до выбора условий.';}}
function setBusy(value){busy=value;syncTerritoryControls();$('run').firstChild.textContent=value?'Считаю… ':'Построить анализ ';root.querySelectorAll('#analysis-form fieldset').forEach(f=>f.disabled=value||bootstrapPending);$('job-banner').hidden=!value;}
async function startAnalysis(event){
  event?.preventDefault();
  if(busy||!active||!validateInputs())return;
  if(source==='all'){$('error-banner').hidden=false;$('error-banner').textContent='Выберите один спутник для временного анализа. Данные разных платформ не суммируются.';return;}
  stopPlaying();drawing=false;drawStart=null;$('draw-instruction').hidden=true;map.getContainer().style.cursor='';const config=formConfig();const current=++generation;
  analysisAbort?.abort();const controller=new AbortController();analysisAbort=controller;
  planner.prepareRun();revisions.clear();showResultSurface(false);
  $('error-banner').hidden=true;setBusy(true);result=null;matrixPanel.reset();++mapGeneration;mapYear=null;cellsLayer.clearLayers();publishContext();
  $('retry-map').hidden=true;
  $('analysis-area-title').textContent=areaName(config);$('context-note').textContent=`${config.start} — ${config.end} · базовые годы ${config.baseline_start}–${config.baseline_end}`;
  $('job-message').textContent='Создаю пространственный запрос';$('job-progress').value=0;
  $('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=true;
  $('job-banner').tabIndex=-1;$('job-banner').focus({preventScroll:true});$('job-banner').scrollIntoView({block:'start'});
  try{
    const job=await request('/api/v1/analyses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config),signal:controller.signal});if(current!==generation||!active)return;jobId=job.id;
    while(current===generation&&active){
      const state=await request(`/api/v1/analyses/${jobId}`,{signal:controller.signal});
      if(current!==generation||!active)return;
      $('job-message').textContent=state.message;$('job-progress').value=state.progress||0;
      if(state.status==='error')throw new Error(state.message);
      if(state.status==='done'){if(!sameScientificConfig(state.result?.config,config)||!sameScientificConfig(formConfig(),config))throw new Error('Результат относится к другим условиям. Проверьте параметры и повторите расчёт.');acceptResult(state.result);break;}
      await new Promise(resolve=>setTimeout(resolve,1200));
    }
    if(!result||current!==generation||!active)return;
    await displayResult({navigate:true});
  }catch(error){if(current===generation&&active&&error.name!=='AbortError'){planner.runFailed();$('error-banner').hidden=false;$('error-banner').textContent=error.message;$('form-status').textContent='Условия сохранены. Измените параметры или повторите расчёт кнопкой ниже.';}}
  finally{if(analysisAbort===controller)analysisAbort=null;if(current===generation&&active)setBusy(false);}
}
function acceptResult(candidate){
 if(!candidate?.config)throw new Error('В расчёте отсутствуют научные параметры.');
 scientificSignature(candidate.config);
 const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
 result={...candidate,config:freeze(clone(candidate.config))};
}
function syncCanonicalConfig(config){
 territorySelected=true;
 $('preset').value=config.preset;
 ['west','south','east','north'].forEach((key,index)=>$(key).value=config.bbox[index]);
 $('start').value=config.start;$('end').value=config.end;$('baseline-start').value=config.baseline_start;$('baseline-end').value=config.baseline_end;$('grid').value=config.grid_km;$('include-nrt').checked=config.quality==='all';$('daynight').value=config.daynight;
 roiCircle=config.circle?clone(config.circle):null;
 const geometry=config.geometry||(config.preset==='sko'?settings?.region_geometry:null);
 roiGeometry=roiCircle?null:geometry?clone(geometry.type==='Feature'?geometry.geometry:geometry):null;
 roiName=config.roi_name||'';roiSource=config.roi_source||'';
 $('analysis-area-title').textContent=areaName(config);showBounds(false);
}
function rejectCachedResult(message){
 if(busy)setBusy(false);invalidate();pendingViewState=null;
 $('error-banner').hidden=false;$('error-banner').textContent=message;$('form-status').textContent='Параметры выбранной территории сохранены. Нажмите «Построить анализ», чтобы получить соответствующие данные.';bridge.notice?.(message);
}
async function displayResult({navigate=false}={}){
    const config=result.config;syncCanonicalConfig(config);
    const rows=result.monthly.filter(r=>r.platform===source&&r.cells!==null);
    const lastYear=rows.at(-1)?.month.slice(0,4);
    month=rows.filter(r=>r.month.startsWith(lastYear)).sort((a,b)=>(b.cells||0)-(a.cells||0))[0]?.month||rows.at(-1)?.month;
    const keys=[...new Set(result.monthly.map(r=>r.month))];$('focus-month').replaceChildren(...keys.map(k=>new Option(formatMonth(k),k)));$('focus-month').disabled=!keys.length;if(!keys.length)$('focus-month').append(new Option('Нет доступных месяцев',''));
    $('focus-month').value=month||keys.at(-1);month=$('focus-month').value;
    $('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=$('play-days').disabled=$('day-range').disabled=$('reset-day').disabled=$('last-month').disabled=false;
    $('form-status').textContent='Анализ готов. Выберите месяц календаря или откройте другие представления результата.';
    $('context-note').textContent=`${config.start} — ${config.end} · сетка ${config.grid_km} км · ${config.quality==='sp'?'стандартный архив SP':'SP + предварительные NRT'}`;
    $('provenance-details').textContent=JSON.stringify({parameters:result.config,snapshot_at:result.snapshot_at,calculated_at:result.calculated_at,provenance:result.provenance},null,2);
    frame=0;mapYear=null;populateCompareYears();applyFocus(retainedFocus);restoreView(pendingViewState);pendingViewState=null;showResultSurface(source!=='all');
    if(source!=='all'){renderAll();planner.resultReady({id:jobId,platform:source,month},{navigate});if(navigate){pendingQuestionNavigation=false;$('study-assessment').tabIndex=-1;$('study-assessment').focus({preventScroll:true});$('study-assessment').scrollIntoView({block:'start'});}matrixPanel.refresh();if(active)await updateMap();}
    else{$('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=true;$('form-status').textContent='Расчёт сохранён. Выберите один спутник для просмотра; платформы не суммируются.';$('map-count').textContent='Выберите один спутник';}
    publishContext();
}

function calibrated(){return $('series-mode').value==='calibrated';}
function monthlyValue(row){return !row?null:calibrated()?(row.model_valid===true&&Number.isFinite(row.aqua_equivalent)?row.aqua_equivalent:null):row.cells;}
function monthlyBaseline(row){return !row?null:calibrated()?(row.model_valid===true&&Number.isFinite(row.baseline_equivalent)?row.baseline_equivalent:null):row.baseline;}
function coefficient(value){return Number.isFinite(value)?numberFormat({maximumSignificantDigits:4}).format(value):'—';}
function comparisonAvailable(row){return row&&(!row.comparison_status||row.comparison_status==='ok');}
function comparisonMessage(row){
 if(row?.comparison_status==='incomplete_utc_day'){
  const lastCompleteDay=result?.last_complete_day||settings?.last_complete_day;
  return `Последние сутки неполные; сравнение с историей недоступно.${lastCompleteDay?` Для сравнения задайте конец не позже ${lastCompleteDay}.`:''}`;
 }
 if(row?.comparison_status==='insufficient_target_days')return 'Недостаточно дней глобального продукта в выбранном периоде; сравнение с историей недоступно.';
 if(row?.comparison_status==='insufficient_baseline'||row?.baseline_years<3)return `Для сравнения доступны ${row?.baseline_years??0} других базовых лет; нужно минимум три.`;
 if(calibrated()&&Number.isFinite(row?.baseline)&&!Number.isFinite(monthlyBaseline(row)))return 'Историческая база не допущена к SP-калибровке. Сравнение доступно в исходной шкале.';
 if(row?.baseline===0)return 'В базовом периоде записанной активности нет; процентное отклонение не определено.';
 if(!Number.isFinite(row?.percentile))return 'Исторический ранг не оценён. Локальная видимость неизвестна.';
 return `${row.baseline_years} сопоставимых базовых лет · исторический ранг ${n(row.percentile)}%.${row.partial?' Сравниваются одинаковые части месяца.':''} Локальная видимость неизвестна.`;
}
function sourceRows(platform=source){return result?.monthly.filter(r=>r.platform===platform)||[];}
function currentRow(){return sourceRows().find(r=>r.month===month);}
function frameDates(){if(!result||!month)return [];const start=month+'-01';const max=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();return Array.from({length:max},(_,i)=>month+'-'+String(i+1).padStart(2,'0')).filter(d=>d>=result.config.start&&d<=result.config.end);}
function renderAll(){
 if(!result)return;
 const model=result.models[source],option=$('series-mode').querySelector('[value=calibrated]');
 option.disabled=!model?.accepted||!sourceRows().some(r=>r.model_valid===true&&Number.isFinite(r.aqua_equivalent));
 option.textContent='В шкале Aqua · проверенные SP';
 if(option.disabled)$('series-mode').value='raw';
 renderInsights();renderChart();renderCalendar();renderSeason();renderComparison();renderValidation();
 $('series-source').textContent=labels[source];
 $('activity-unit').textContent=`ячейко-дни · сетка ${result.config.grid_km} км${calibrated()?' · оценка Aqua, SP':''}`;
 $('day-range').max=frameDates().length;$('day-range').value=frame;
 $('day-label').textContent=rangeFocus?'Диапазон UTC':mapYear?`ISO-год ${mapYear}`:frame?frameDates()[frame-1]:'Весь месяц';
 const monthlyMap=mapMode==='activity'&&!mapYear&&!rangeFocus;
 $('play-days').disabled=$('day-range').disabled=$('reset-day').disabled=!monthlyMap;
 $('map-mode').disabled=Boolean(mapYear||rangeFocus);
 renderFocusScope();
 matrixPanel.refresh();
 revisions.refresh();
}
function isRangeFocus(focus){return Boolean(focus?.start&&focus?.end&&focus.basis!=='ISO'&&focus.grain!=='day'&&focus.grain!=='month');}
function clearRangeFocus(){rangeFocus=null;retainedFocus=null;renderFocusScope();}
function renderFocusScope(){
 $('focus-scope').hidden=!rangeFocus;
 $('insight-title').textContent=rangeFocus?'Выбранный месяц календаря':'Активность выбранного месяца';
 if(!rangeFocus){$('map-mode').title='';return;}
 $('focus-scope-label').textContent=`Карта: ${rangeFocus.start} — ${rangeFocus.end} · UTC включительно`;
 $('focus-scope-note').textContent=`${result?'Карта показывает':'После расчёта карта покажет'} исходные ячейко-дни за выбранный диапазон. Календарь и карточка остаются помесячными; их выбранный месяц указан отдельно. Согласование применяется только к месяцам. Месячная карта отклонений и суточное воспроизведение для диапазона отключены.`;
 mapMode='activity';$('map-mode').value='activity';$('map-mode').disabled=true;$('play-days').disabled=$('day-range').disabled=$('reset-day').disabled=true;$('map-mode').title='Диапазон UTC показывается в исходной шкале. Для карты отклонений выберите месяц.';
}
function renderInsights(){
 const row=currentRow();if(!row){['activity-value','baseline-value','anomaly-value','season-months'].forEach(id=>$(id).textContent='—');$('points-value').textContent='Нет доступного ряда выбранной платформы.';$('anomaly-context').textContent='Сравнение недоступно для этого спутника и месяца. Локальная видимость неизвестна.';$('reference-disagreement').hidden=true;return;}
 const value=monthlyValue(row),baseline=monthlyBaseline(row),unvalidated=calibrated()&&value===null;
 const anomalyAvailable=!unvalidated&&comparisonAvailable(row)&&Number.isFinite(row.anomaly_pct)&&Number.isFinite(baseline);
 $('activity-value').textContent=n(value);
 $('points-value').textContent=row.points===null?'Нет доступного ряда':`${n(row.points)} детекций · ${row.eligible_days}/${row.calendar_days} дней глобального продукта${row.nrt_points||row.preliminary_days?' · есть NRT':''}`;
 $('baseline-value').textContent=n(comparisonAvailable(row)?baseline:null);
 $('anomaly-value').textContent=anomalyAvailable?`${row.anomaly_pct>0?'+':''}${n(row.anomaly_pct)}%`:'—';
 $('anomaly-value').style.color=row.anomaly_pct>50?'var(--orange)':'var(--app-accent)';
 const conclusion=anomalyAvailable?(row.anomaly_pct>0?'Зарегистрированная активность выше исторического уровня. ':row.anomaly_pct<0?'Зарегистрированная активность ниже исторического уровня. ':'Зарегистрированная активность совпадает с историческим уровнем. '):'';
 $('anomaly-context').textContent=conclusion+(!comparisonAvailable(row)?comparisonMessage(row):unvalidated?'Этот месяц не допущен к SP-калибровке. Оперативные и непроверенные периоды доступны в исходном режиме.':row.cells===null?'В этом периоде у выбранной платформы нет доступного продукта.':comparisonMessage(row));
 const aqua=sourceRows('Aqua').find(r=>r.month===month);
 const disagrees=anomalyAvailable&&comparisonAvailable(aqua)&&source!=='Aqua'&&Number.isFinite(aqua?.anomaly_pct)&&row.anomaly_pct*aqua.anomaly_pct<0&&Math.abs(row.anomaly_pct)>1&&Math.abs(aqua.anomaly_pct)>1;
 $('reference-disagreement').hidden=!disagrees;
 if(disagrees)$('reference-disagreement').textContent=`Спутники расходятся: Aqua ${aqua.anomaly_pct>0?'+':''}${n(aqua.anomaly_pct)}% к своей базе. Направление изменения не подтверждается обоими приборами.`;
 const high=result.profiles[source]?.high_activity_months||[];
 const peakMonths=high.flatMap((month,index)=>index?[', ',longMonths[month-1]]:[longMonths[month-1]]);
 $('season-months').replaceChildren(...(peakMonths.length?peakMonths:['Недостаточно базовых лет']));
}
function chart(id, series, options={}){
 const host=$(id);host.replaceChildren();const width=Math.max(290,host.clientWidth),height=host.clientHeight||183,left=47,right=13,top=14,bottom=29;
 const valid=series.flatMap(s=>s.values.filter(v=>Number.isFinite(v)));if(!valid.length){empty(id,'Недостаточно данных для этого вида анализа.');return;}
 const max=Math.max(1,...valid,...(options.band||[]).flatMap(v=>v.filter(Number.isFinite)))*1.12;
 const count=Math.max(...series.map(s=>s.values.length));const x=i=>left+(width-left-right)*(count<=1?.5:i/(count-1));const y=v=>height-bottom-(height-top-bottom)*v/max;
 const svg=svgElement('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':options.label||'Временной ряд пожарной активности'});
 for(let i=0;i<4;i++){const value=max*i/3;svg.append(svgElement('line',{x1:left,y1:y(value),x2:width-right,y2:y(value),class:'gridline'}),svgElement('text',{x:left-7,y:y(value)+3,'text-anchor':'end'},n(value)));}
 if(options.band){
  let segment=[];
  const drawBand=()=>{if(segment.length>1){const low=segment.map(([i,v])=>[x(i),y(v[0])]),high=segment.map(([i,v])=>[x(i),y(v[1])]).reverse();svg.append(svgElement('polygon',{points:[...low,...high].map(p=>p.join(',')).join(' '),fill:'#70c1ff','fill-opacity':'.20'}));}segment=[];};
  options.band.forEach((v,i)=>{if(v.every(Number.isFinite))segment.push([i,v]);else drawBand();});drawBand();
 }
 const stride=Math.max(1,Math.ceil(count/Math.max(3,Math.floor(width/100))));
 for(let i=0;i<count;i++)if(i%stride===0||i===count-1)svg.append(svgElement('text',{x:x(i),y:height-8,'text-anchor':'middle'},options.labels?.[i]||''));
 series.forEach(s=>{let segments=[],current=[];s.values.forEach((value,i)=>{if(!Number.isFinite(value)){if(current.length)segments.push(current);current=[];}else current.push([x(i),y(value),i,value]);});if(current.length)segments.push(current);segments.forEach(points=>{svg.append(svgElement('polyline',{points:points.map(p=>p.slice(0,2).join(',')).join(' '),fill:'none',stroke:s.color,'stroke-width':s.width||1.8,'stroke-linejoin':'round'}));points.forEach(([cx,cy,i,value])=>{if(count<60||s.values.length<120){const circle=svgElement('circle',{cx,cy,r:2.3,fill:s.color});circle.append(svgElement('title',{},`${options.tooltips?.[i]||options.labels?.[i]||''} · ${s.name}: ${n(value)}`));svg.append(circle);}});});});
 if(options.focus>=0)svg.append(svgElement('line',{x1:x(options.focus),x2:x(options.focus),y1:top,y2:height-bottom,stroke:'#d9aa64','stroke-width':1,'stroke-dasharray':'3 3'}));
 if(options.onSelect){svg.style.cursor='crosshair';svg.addEventListener('click',event=>{const point=(event.clientX-svg.getBoundingClientRect().left)*width/svg.getBoundingClientRect().width;const i=Math.max(0,Math.min(count-1,Math.round((point-left)/(width-left-right)*(count-1))));options.onSelect(i);});}
 host.append(svg);
}
function renderChart(){
 if(!result)return;let keys,values,reference,labelsX,click;
 if(step==='month'){
  const rows=sourceRows(),aqua=new Map(sourceRows('Aqua').map(r=>[r.month,r.cells]));keys=rows.map(r=>r.month);values=rows.map(monthlyValue);reference=keys.map(k=>aqua.get(k));labelsX=keys.map(k=>`${months[Number(k.slice(5))-1]} ${k.slice(2,4)}`);click=i=>selectMonth(keys[i]);
  $('series-caption').textContent=`${calibrated()?'Оценка в шкале Aqua только в допущенных SP-месяцах; остальные — разрывы. ':'Исходные ячейко-дни без объединения спутников. '}Нажмите месяц для перехода к карте. Неполные месяцы помечены в выбранном периоде.`;
 }else{
  const lookup=new Map(result.daily.map(r=>[r.date+'|'+r.platform,r]));const available=new Set(result.availability.filter(r=>result.config.quality==='all'||r.sp).map(r=>r.date+'|'+r.platform));const dates=frameDates();
  const rows=dates.map(d=>({date:d,value:available.has(d+'|'+source)?(lookup.get(d+'|'+source)?.cells||0):null,aqua:available.has(d+'|Aqua')?(lookup.get(d+'|Aqua')?.cells||0):null}));
  if(step==='week'){
   const groups=new Map();for(const row of rows){const d=new Date(row.date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);const key=d.toISOString().slice(0,10);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
   keys=[...groups.keys()];const sum=(list,field)=>list.some(r=>r[field]!==null)?list.reduce((s,r)=>s+(r[field]||0),0):null;values=keys.map(k=>sum(groups.get(k),'value'));reference=keys.map(k=>sum(groups.get(k),'aqua'));labelsX=keys.map(k=>k.slice(5));click=i=>selectFrame(Math.max(1,dates.findIndex(d=>d>=keys[i])+1));
  }else{keys=dates;values=rows.map(r=>r.value);reference=rows.map(r=>r.aqua);labelsX=keys.map(k=>k.slice(8));click=i=>selectFrame(i+1);}
  $('series-caption').textContent=`${step==='week'?'Исходная шкала: неперекрывающиеся недели; крайние окна могут быть неполными.':'Исходная шкала: дни выбранного месяца; разрывы — нет доступного продукта.'} Ноль — нет записанных детекций, локальная видимость неизвестна.`;
 }
 const lines=[{name:labels[source],values,color:'#ffa46e'}];if(source!=='Aqua')lines.push({name:'Aqua / MODIS',values:reference,color:'#70c1ff'});
 chart('series-chart',lines,{labels:labelsX,tooltips:keys,focus:step==='month'?keys.indexOf(month):frame-1,onSelect:click});
}
function renderCalendar(){
 if(!result)return;
 const host=$('calendar-grid');host.replaceChildren();
 const add=(text,cls)=>{const node=document.createElement('span');node.textContent=text;node.className=cls;host.append(node);};
 add('UTC','calendar-label');months.forEach(m=>add(m,'calendar-label'));
 const rows=sourceRows(),lookup=new Map(rows.map(r=>[r.month,r])),max=Math.max(1,...rows.map(r=>monthlyValue(r)||0));
 if(!rows.length){const note=document.createElement('p');note.className='calendar-empty';note.textContent='Для выбранного спутника в этой истории нет доступных месяцев. Измените условия или выберите другой ряд.';host.replaceChildren(note);return;}
 const anomalies=$('calendar-anomalies').checked,years=[...new Set(rows.map(r=>r.month.slice(0,4)))];
 for(const year of years){
  add(year,'calendar-label');
  for(let m=1;m<=12;m++){
   const key=`${year}-${String(m).padStart(2,'0')}`,row=lookup.get(key),button=document.createElement('button');
   const value=monthlyValue(row),missingComparisonBaseline=anomalies&&calibrated()&&!Number.isFinite(monthlyBaseline(row)),noData=!row||value===null||missingComparisonBaseline||(anomalies&&(!comparisonAvailable(row)||!Number.isFinite(row.anomaly_pct)));
   button.className='calendar-cell';button.type='button';
   if(noData){button.classList.add('missing');button.textContent='—';button.title=anomalies&&row&&!comparisonAvailable(row)?comparisonMessage(row):missingComparisonBaseline&&value!==null?'Историческая база не допущена к SP-калибровке':calibrated()&&row?.cells!==null?'Период не допущен к SP-калибровке':anomalies?'Процентное отклонение не оценено':'Нет доступного ряда';}
   else{
    const intensity=Math.log1p(value)/Math.log1p(max);
    if (anomalies) {
     const deviation = row.anomaly_pct;
     const magnitude = Math.min(1, Math.abs(deviation) / (deviation > 0 ? 200 : 100));
     button.style.background = `hsl(${deviation > 0 ? 22 : 210} 59% ${19 + magnitude * 19}%)`;
    } else {
     button.style.background = `hsl(${30 - 16 * intensity} 64% ${18 + intensity * 21}%)`;
    }
    button.textContent=anomalies?`${row.anomaly_pct>0?'+':''}${Math.round(row.anomaly_pct)}%`:n(value);
    button.title=`${formatMonth(key)}: ${n(value)} ячейко-дней${calibrated()?' в шкале Aqua':''}; ${n(row.points)} детекций. ${value===0?'Обнаружений нет; ':''}локальная видимость неизвестна.`;
    if(value===0)button.classList.add('zero-detections');
   }
   if(key===month)button.classList.add('focus');
   button.disabled=!row;button.setAttribute('aria-label',button.title||formatMonth(key));
   button.dataset.month=key;
   button.addEventListener('click',()=>{selectMonth(key);step='week';syncStepControls();activateTab('series');$('tab-series').focus({preventScroll:true});});
   host.append(button);
  }
 }
}
function weeklyValues(year){
 const rows=result?.weekly_profiles?.[source]?.years?.[String(year)]||[];
 const lookup=new Map(rows.map(row=>[Number(row.week),row]));
 return Array.from({length:53},(_,i)=>lookup.get(i+1)||null);
}
function renderSeason(){
 if(!result)return;
 const weekly=result.weekly_profiles?.[source],selectedYear=month?.slice(0,4);
 $('season-year-label').textContent=selectedYear?`ISO-${selectedYear}`:'Выбранный ISO-год';
 if(weekly?.weeks?.length){
  const lookup=new Map(weekly.weeks.map(row=>[Number(row.week),row])),profile=Array.from({length:53},(_,i)=>lookup.get(i+1)),observed=weeklyValues(selectedYear);
  const lines=[{name:'Базовая медиана',values:profile.map(row=>row?.years>=3?row.median:null),color:'#70c1ff'},
   {name:String(selectedYear),values:observed.map(row=>row&&Number.isFinite(row.rate)?row.rate:null),color:'#ffa46e'}];
  const options={labels:profile.map((_,i)=>String(i+1)),tooltips:profile.map((_,i)=>`Неделя ISO ${i+1}`),band:profile.map(row=>row?.years>=3?[row.low,row.high]:[null,null]),label:'Недельный сезонный профиль в исходной шкале: ячейко-дни на день глобального продукта'};
  chart('season-chart',lines,options);chart('calendar-season-chart',lines,options);
  const text='Недели ISO · исходные ячейко-дни на день глобального продукта. Полоса — межгодовой диапазон 10–90%, не прогноз и не локальное покрытие.';
  $('seasonal-caption').textContent=$('season-detail-caption').textContent=text;
  $('season-unit').textContent='Исходные ячейко-дни / доступный день';
 }else{
  const profile=result.profiles[source]?.months||[],lookup=new Map(sourceRows().filter(row=>row.month.startsWith(selectedYear)).map(row=>[Number(row.month.slice(5)),row]));
  const lines=[{name:'Базовая медиана',values:profile.map(row=>row.years>=3?row.median:null),color:'#70c1ff'},
   {name:String(selectedYear),values:profile.map(row=>{const observed=lookup.get(row.month);return observed?.eligible_days&&!observed.partial?observed.cells/observed.eligible_days:null;}),color:'#ffa46e'}];
  const options={labels:months,tooltips:longMonths,band:profile.map(row=>row.years>=3?[row.low,row.high]:[null,null]),label:'Месячный профиль в исходной шкале'};
  chart('season-chart',lines,options);chart('calendar-season-chart',lines,options);
  $('seasonal-caption').textContent=$('season-detail-caption').textContent='Показан месячный профиль в исходной шкале: недельные результаты ещё не доступны. Полоса — межгодовой диапазон 10–90%, не прогнозный интервал.';
  $('season-unit').textContent='Месячный профиль · исходная шкала';
 }
}
function populateCompareYears(){
 if(!result)return;
 const weeklyYears=result.weekly_profiles?.[source]?.years;
 const years=weeklyYears?Object.keys(weeklyYears).filter(year=>weeklyYears[year].some(row=>row.cells!==null)):[...new Set(sourceRows().filter(row=>row.cells!==null).map(row=>row.month.slice(0,4)))];
 if(!years.includes(compareYearA))compareYearA=years.at(-2)||years[0]||null;
 if(!years.includes(compareYearB))compareYearB=years.at(-1)||null;
 $('compare-year-a').replaceChildren(...years.map(year=>new Option(year,year)));
 $('compare-year-b').replaceChildren(...years.map(year=>new Option(year,year)));
 $('compare-year-a').value=compareYearA||'';$('compare-year-b').value=compareYearB||'';
 $('compare-year-a').disabled=$('compare-year-b').disabled=!years.length;
 $('compare-map-a').disabled=!compareYearA;$('compare-map-b').disabled=!compareYearB;
}
function renderComparison(){
 if(!result)return;
 populateCompareYears();
 $('compare-label-a').textContent=compareYearA||'Первый год';$('compare-label-b').textContent=compareYearB||'Второй год';
 $('compare-map-a').textContent=compareYearA?`${compareYearA} на карте`:'Первый год на карте';
 $('compare-map-b').textContent=compareYearB?`${compareYearB} на карте`:'Второй год на карте';
 $('compare-map-a').setAttribute('aria-pressed',mapYear===compareYearA);
 $('compare-map-b').setAttribute('aria-pressed',mapYear===compareYearB);
 const host=$('compare-metrics');host.replaceChildren();
 const weekly=result.weekly_profiles?.[source];
 if(!weekly?.weeks?.length){empty('compare-chart','Недельные результаты ещё не доступны. Сравнение сезонов появится после их расчёта.');return;}
 if(!compareYearA||!compareYearB||compareYearA===compareYearB){empty('compare-chart','Для сравнения выберите два разных года с доступным рядом выбранного спутника.');return;}
 const a=weeklyValues(compareYearA),b=weeklyValues(compareYearB);
 chart('compare-chart',[{name:compareYearA,values:a.map(row=>row?.rate??null),color:'#70c1ff'},
  {name:compareYearB,values:b.map(row=>row?.rate??null),color:'#ffa46e'}],
  {labels:Array.from({length:53},(_,i)=>String(i+1)),tooltips:Array.from({length:53},(_,i)=>`Неделя ISO ${i+1}`),label:`Сравнение ${compareYearA} и ${compareYearB}: исходные ячейко-дни на доступный день`});
 const metrics=weekly.year_metrics||{},ma=metrics[compareYearA]||{},mb=metrics[compareYearB]||{};
 const table=document.createElement('table'),caption=document.createElement('caption');caption.textContent='ISO-годы · активность по одинаковому историческому порогу';table.append(caption);
 const head=document.createElement('tr');['Показатель',compareYearA,compareYearB].forEach(text=>{const th=document.createElement('th');th.scope='col';th.textContent=text;head.append(th);});
 const thead=document.createElement('thead');thead.append(head);table.append(thead);
 const tbody=document.createElement('tbody');
 const week=value=>Number.isFinite(value)?`неделя ${value}`:'—';
 for(const [name,key,format] of [['Первая неделя выше порога','first_week',week],['Пиковая неделя','peak_week',week],['Последняя неделя выше порога','last_week',week],['Недель выше порога','active_weeks',n],['Исходные ячейко-дни','total_cells',n]]){
  const row=document.createElement('tr'),title=document.createElement('th');title.scope='row';title.textContent=name;row.append(title);
  for(const value of [ma[key],mb[key]]){const cell=document.createElement('td');cell.textContent=format(value);row.append(cell);}tbody.append(row);
 }
 const period=document.createElement('tr'),periodTitle=document.createElement('th');periodTitle.scope='row';periodTitle.textContent='Период ISO-года';period.append(periodTitle);for(const metrics of [ma,mb]){const cell=document.createElement('td');cell.textContent=metrics.start_date&&metrics.end_date?`${metrics.start_date} — ${metrics.end_date}${metrics.partial_year?' · неполный':''}`:'—';period.append(cell);}tbody.append(period);table.append(tbody);host.append(table);
 $('compare-caption').textContent=`ISO-годы, исходная шкала ${labels[source]}; доступность глобального продукта не равна местному покрытию. ${Number.isFinite(weekly.threshold)?`Исторический порог: ${n(weekly.threshold)} ячейко-дней на доступный день.`:'Для исторического порога недостаточно базовых данных.'} Первая и последняя недели выше порога — не даты начала и окончания отдельных пожаров. Разрывы кривых означают недостаток доступного ряда.`;
}
function renderValidation(){
 if(!result)return;const model=result.models[source],host=$('validation-summary');host.replaceChildren();
 if(!model){const p=document.createElement('p');p.textContent='Aqua — выбранная опорная шкала. Выберите VIIRS или Terra для отдельной проверки сопоставимости.';host.append(p);empty('validation-chart','Опорный прибор сравнивается с выбранной второй платформой.');return;}
 const status=document.createElement('div');status.className='validation-status'+(model.accepted?'':' warn');status.textContent=model.accepted?'Отложенная проверка согласования пройдена · результат экспериментальный':'Калибровка не допущена: не выполнены условия отложенной проверки.';host.append(status);
 for(const [name,value] of [['Коэффициент',coefficient(model.coefficient)],['MAE до → после',`${n(model.mae_before)} → ${n(model.mae_after)}`],['Обучение / тест',`${model.fit_months} / ${model.test_months} мес.`],['Смещение на тесте',model.bias_pct===undefined?'—':`${n(model.bias_pct)}%`]]){const block=document.createElement('div');block.append(document.createTextNode(name));const strong=document.createElement('strong');strong.textContent=value;block.append(strong);host.append(block);}
 const pairs=model.pairs.filter(p=>Number(p.month.slice(0,4))>result.config.baseline_end);
 chart('validation-chart',[{name:'Aqua на общих SP-датах',values:pairs.map(p=>p.aqua),color:'#70c1ff'},{name:'Исходный '+source,values:pairs.map(p=>p.partner),color:'#b0bedb',width:1},{name:'Оценка Aqua по '+source,values:pairs.map(p=>model.coefficient===null?null:p.partner*model.coefficient),color:'#ffa46e'}],{labels:pairs.map(p=>p.month.slice(2)),tooltips:pairs.map(p=>p.month),label:'Отложенная проверка калибровки: Aqua, исходный и скорректированный спутник'});
 $('validation-note').textContent=`Обучение ${model.fit_start}–${model.fit_end}; контроль — только последующие годы. Общие SP-даты, ≥10 дней в месяце. Условия прототипа: ≥24 месяца обучения, ≥12 теста, MAE ниже исходной и не выше сезонной модели (${n(model.seasonal_mae)}), смещение ≤35%.${model.coefficient_interval?` Разброс коэффициента по выборкам целых лет: ${coefficient(model.coefficient_interval[0])}–${coefficient(model.coefficient_interval[1])}.`:''} Локальная видимость неизвестна.`;
}
function selectMonth(key){if(!result||!key)return;stopPlaying();clearRangeFocus();month=key;frame=0;mapYear=null;$('focus-month').value=month;renderAll();planner.updateMonth({platform:source,month});updateMap();publishContext();}
function selectFrame(index){if(!result)return;stopPlaying();clearRangeFocus();mapYear=null;frame=index;renderAll();updateMap();publishContext();}
async function updateMap(){
 if(!active||!result||!month)return;
 const range=rangeFocus?clone(rangeFocus):null;
 const current=++mapGeneration,activeResult=result,period=range?range.start.slice(0,7):mapYear||month,day=mapYear||range?null:frame?frameDates()[frame-1]:null;
 const anomaly=mapMode==='anomaly'&&!mapYear&&!range;
 $('map-period').textContent=`${range?`${range.start} — ${range.end} UTC`:mapYear?`ISO-год ${mapYear}`:day||formatMonth(month)} · ${labels[source]}`;
 $('map-count').textContent='Обновляю карту…';$('retry-map').hidden=true;
 try{
  const query=new URLSearchParams({month:period,platform:source});
  if(range){query.set('start',range.start);query.set('end',range.end);}
  else if(anomaly){query.set('baseline_start',result.config.baseline_start);query.set('baseline_end',result.config.baseline_end);}
  else if(day)query.set('day',day);
  const url=`/api/v1/${anomaly?'anomaly-map':'maps'}/${result.extract_id}?${query}`;
  let data;
  for(let attempt=0;attempt<4;attempt++){
   if(current!==mapGeneration||result!==activeResult)return;
   try{data=await request(url);break;}
   catch(error){
    if(current!==mapGeneration||result!==activeResult)return;
    if(error.status!==429||attempt===3)throw error;
    $('map-count').textContent='Карта занята. Повторяю запрос…';
    await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
   }
  }
  if(current!==mapGeneration||result!==activeResult)return;
  cellsLayer.clearLayers();
  root.querySelector('.color-ramp').classList.toggle('anomaly-ramp',anomaly);
  if(anomaly&&data.status&&data.status!=='ok'){
   $('map-count').textContent=data.message||'Недостаточно сопоставимых базовых лет';
   $('map-key-text').textContent='Отклонение не оценено · локальная видимость неизвестна';return;
  }
  const max=Math.max(1,...data.cells.map(cell=>cell[4]||0));
  for(const cell of data.cells){
   const [west,south,east,north,currentValue,baseline,anomalyPercent,baselineYears]=cell;
   const intensity=Math.log1p(currentValue||0)/Math.log1p(max);
   const color=anomaly?(Number.isFinite(anomalyPercent)?anomalyPercent>0?`hsl(20 75% ${78-Math.min(anomalyPercent/200,1)*32}%)`:`hsl(164 32% ${78-Math.min(-anomalyPercent/100,1)*35}%)`:'#aab5b0'):`hsl(${44-23*intensity} 82% ${75-30*intensity}%)`;
   const layer=L.rectangle([[south,west],[north,east]],{stroke:false,fillColor:color,fillOpacity:.78});
   const popup=document.createElement('div'),title=document.createElement('strong');
   if(anomaly){
    title.textContent=Number.isFinite(anomalyPercent)?`${anomalyPercent>0?'+':''}${n(anomalyPercent)}% к базе`:'Процентное отклонение не определено';
    popup.append(title,document.createElement('br'),`Сейчас: ${n(currentValue)}; база: ${n(baseline)} ячейко-дней`,document.createElement('br'),`${baselineYears??data.baseline_years??0} сопоставимых базовых лет · ${labels[source]}`);
    if(!Number.isFinite(anomalyPercent))popup.append(document.createElement('br'),'Нет ненулевого сопоставимого базового уровня; это не подтверждение нового пожара.');
   }else{
    title.textContent=`${n(currentValue)} исходных ячейко-дней`;
    popup.append(title,document.createElement('br'),`${n(baseline)} детекций · ${labels[source]}`);
   }
   popup.append(document.createElement('br'),'Локальная видимость неизвестна. Площадь ячейки не равна выгоревшей площади.');
   layer.bindPopup(popup);cellsLayer.addLayer(layer);
  }
  $('map-count').textContent=`${n(data.cells.length)} ячеек${anomaly&&data.baseline_years!==undefined?` · ${data.baseline_years} базовых лет`:''}`;
  $('map-key-text').textContent=anomaly?'Карта: отклонения выбранного спутника · не пространственная калибровка':data.display_grid_km===data.grid_km?`Карта: исходные ячейко-дни · сетка ${data.grid_km} км`:`Исходные ячейко-дни ${data.grid_km} км · обзор ${data.display_grid_km} км`;
  if(range)$('map-key-text').textContent+=` · ${range.start} — ${range.end} UTC`;
  if(mapYear){const metrics=activeResult.weekly_profiles?.[source]?.year_metrics?.[mapYear],start=data.start_date||metrics?.start_date,end=data.end_date||metrics?.end_date;if(start&&end)$('map-key-text').textContent+=` · ${start} — ${end}${metrics?.partial_year?' · неполный ISO-год':''}`;}
 }catch(error){if(current===mapGeneration&&result===activeResult){cellsLayer.clearLayers();$('map-count').textContent=error.message;$('map-key-text').textContent=anomaly?'Карта отклонений недоступна':'Не удалось получить карту';$('retry-map').hidden=false;}}
}
function activateTab(next){
 if(next==='season')next='calendar';
 if(!root.querySelector(`[data-view="${CSS.escape(next)}"]`))next='calendar';
 view=next;
 root.querySelectorAll('[data-view]').forEach(tab=>{const selected=tab.dataset.view===view;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',selected);tab.tabIndex=selected?0:-1;});
 root.querySelectorAll('.analysis-view').forEach(panel=>panel.hidden=panel.id!=='view-'+view);
 if(view!=='compare'&&mapYear){mapYear=null;frame=0;updateMap();}
 renderAll();
 matrixPanel.setVisible(view==='matrix');
}
function syncStepControls(){root.querySelectorAll('[data-step]').forEach(button=>button.classList.toggle('selected',button.dataset.step===step));}
function showYearOnMap(year){if(!result||!year)return;stopPlaying();clearRangeFocus();mapYear=year;frame=0;mapMode='activity';$('map-mode').value='activity';renderAll();updateMap();publishContext();}
function exportImage(){
 if(!result)return;
 if(view==='matrix'){matrixPanel.exportImage();return;}
 const width=1120,headerHeight=132,footerHeight=78;
 const title=areaName(result.config),monthlyView=view==='calendar'||view==='series'&&step==='month';
 const mode=calibrated()&&monthlyView?'Оценка Aqua · только допущенные SP-месяцы':view==='validation'?'Отложенная проверка · общие SP-даты':'Исходная шкала';
 const calendarMode=view==='calendar'&&$('calendar-anomalies').checked;
 const metadata=[`${labels[source]} · ${result.config.start} — ${result.config.end} · сетка ${result.config.grid_km} км`,
  `База ${result.config.baseline_start}–${result.config.baseline_end} · ${mode} · снимок архива ${result.snapshot_at}`];
 const root=svgElement('svg',{xmlns:ns,width,viewBox:`0 0 ${width} 700`,role:'img','aria-label':`NASA Space Apps: ${title}`});
 root.append(svgElement('style',{},'text{font-family:Arial,sans-serif;fill:#f5f8ff;font-size:12px}.gridline{stroke:#2a4072}.axisline{stroke:#526c96}'));
 root.append(svgElement('rect',{width:'100%',height:'100%',fill:'#07132d'}),svgElement('text',{x:30,y:35,style:'font-size:22px;font-weight:700'},'NASA Space Apps · '+title));
 metadata.forEach((line,index)=>root.append(svgElement('text',{x:30,y:62+index*20},line)));
 if(calendarMode)root.append(svgElement('text',{x:30,y:111,'font-size':11},`Календарь: отклонения от базы (%). ${formatMonth(month)}: ${comparisonMessage(currentRow())}`));
 let contentHeight=0;
 if(view==='calendar'){
  const grid=$('calendar-grid'),children=[...grid.children],cellWidth=(width-112)/12,rowHeight=32,left=72;
  const rows=Math.ceil(children.length/13);
  children.forEach((node,index)=>{const column=index%13,row=Math.floor(index/13),x=column===0?28:left+(column-1)*cellWidth,y=headerHeight+row*rowHeight;
   if(node.classList.contains('calendar-cell'))root.append(svgElement('rect',{x,y,width:cellWidth-5,height:rowHeight-5,rx:3,fill:node.classList.contains('missing')?'#162a51':getComputedStyle(node).backgroundColor,stroke:node.classList.contains('focus')?'#8bc6ff':'none'}));
   root.append(svgElement('text',{x:column===0?x:x+(cellWidth-5)/2,y:y+19,'text-anchor':column===0?'start':'middle','font-size':11},node.textContent));
  });
  contentHeight=rows*rowHeight+20;
  const season=$('calendar-season-chart').querySelector('svg');
  if(season){const clone=season.cloneNode(true);clone.setAttribute('x',24);clone.setAttribute('y',headerHeight+contentHeight);clone.setAttribute('width',width-48);clone.setAttribute('height',210);root.append(clone);contentHeight+=230;}
  root.append(svgElement('text',{x:30,y:headerHeight+contentHeight+2,'font-size':10},`Календарь: ${calendarMode?'отклонение от исторической базы (%)':'ячейко-дни'}; сезонный профиль: исходные ячейко-дни на доступный день.`));
 }else{
  const chartIds={series:'series-chart',season:'season-chart',compare:'compare-chart',validation:'validation-chart'},svg=$(chartIds[view]).querySelector('svg');
  if(!svg){$('error-banner').hidden=false;$('error-banner').textContent='Для этого представления пока недостаточно данных для экспорта графика.';return;}
  const clone=svg.cloneNode(true);clone.setAttribute('x',24);clone.setAttribute('y',headerHeight);clone.setAttribute('width',width-48);clone.setAttribute('height',270);root.append(clone);contentHeight=290;
  const caption=view==='compare'?$('compare-caption').textContent:view==='validation'?$('validation-note').textContent:view==='season'?$('season-detail-caption').textContent:$('series-caption').textContent;
  wrapSvgText(root,caption,30,headerHeight+contentHeight,width-60,12);contentHeight+=66;
  if(view==='compare'){
   const rows=[...$('compare-metrics').querySelectorAll('tr')];
   rows.forEach((row,index)=>{const text=[...row.children].map(cell=>cell.textContent).join('    |    ');root.append(svgElement('text',{x:30,y:headerHeight+contentHeight+index*22,'font-size':12},text));});contentHeight+=rows.length*22;
  }
 }
 const height=headerHeight+contentHeight+footerHeight;root.setAttribute('height',height);root.setAttribute('viewBox',`0 0 ${width} ${height}`);
 wrapSvgText(root,'Локальная облачность и пригодность пролётов неизвестны. Детекции и ячейко-дни не равны числу пожаров или выгоревшей площади. Недельные сравнения и карты остаются в исходной шкале. NASA FIRMS / ESDIS через Portolan / Source Cooperative.',30,height-44,width-60,11);
 localizeTree(root);
 const blob=new Blob([new XMLSerializer().serializeToString(root)],{type:'image/svg+xml;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=`nasa-space-apps-${view}-${source.replace(/[^a-z0-9-]/gi,'-')}-${month||'history'}.svg`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function wrapSvgText(svg,text,x,y,width,fontSize){
 const max=Math.max(20,Math.floor(width/(fontSize*.55))),words=translate(text).split(/\s+/);let line='',row=0;
 for(const word of words){if((line+' '+word).length>max&&line){svg.append(svgElement('text',{x,y:y+row*17,'font-size':fontSize},line));row++;line=word;}else line+=(line?' ':'')+word;}
 if(line)svg.append(svgElement('text',{x,y:y+row*17,'font-size':fontSize},line));
}
function stopPlaying(){playing=false;$('play-days').textContent='▶ По дням';}
async function play(){if(!result||mapMode!=='activity'||mapYear||rangeFocus)return;if(playing){stopPlaying();return;}playing=true;$('play-days').textContent='Ⅱ Пауза';while(playing&&result){frame=frame>=frameDates().length?1:frame+1;renderAll();await updateMap();await new Promise(resolve=>setTimeout(resolve,900));}}
function openMethod(){$('method-dialog').showModal();}
$('analysis-form').addEventListener('submit',startAnalysis);
$('preset').addEventListener('change',setPreset);
$('analysis-territory-find').addEventListener('click',searchTerritory);
$('analysis-territory-query').addEventListener('input',()=>{cancelTerritorySearch();$('analysis-territory-status').textContent='';if($('analysis-territory-query').value.trim().length>=2)territoryTimer=setTimeout(searchTerritory,260);});
$('analysis-territory-query').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();searchTerritory();}else if(event.key==='ArrowDown'){event.preventDefault();$('analysis-territory-results').querySelector('button')?.focus();}else if(event.key==='Escape')cancelTerritorySearch();});
$('analysis-territory-results').addEventListener('keydown',event=>{const buttons=[...$('analysis-territory-results').querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}else if(event.key==='Escape'){cancelTerritorySearch();$('analysis-territory-query').focus();}});
['start','end','baseline-start','baseline-end','grid','daynight','include-nrt'].forEach(id=>{const events=['grid','daynight','include-nrt'].includes(id)?['change']:['input','change'];for(const event of events)$(id).addEventListener(event,()=>{for(const input of $('analysis-form').querySelectorAll('input'))input.setCustomValidity('');invalidate();publishContext();});});
$('analysis-form').addEventListener('input',event=>{if(['west','south','east','north'].includes(event.target.id)){event.target.setCustomValidity('');cancelTerritorySearch();territorySelected=true;clearShape();$('preset').value='custom';invalidate();publishContext();}});
$('apply-bounds').addEventListener('click',()=>{cancelTerritorySearch();territorySelected=true;clearShape();$('preset').value='custom';showBounds();invalidate();publishContext();});
$('platform').addEventListener('change',()=>{
 source=$('platform').value;stopPlaying();frame=0;mapYear=null;planner.invalidate();++mapGeneration;cellsLayer.clearLayers();$('error-banner').hidden=true;
 if(result&&sameScientificConfig(result.config,formConfig())){
  showResultSurface(source!=='all');
  if(source==='all'){$('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=true;$('form-status').textContent='Расчёт сохранён. Выберите один спутник для просмотра; платформы не суммируются.';$('map-count').textContent='Выберите один спутник';$('map-key-text').textContent='Разные платформы не суммируются.';$('map-period').textContent='Область исследования';}
  else{$('export-csv').disabled=$('export-json').disabled=$('export-image').disabled=false;populateCompareYears();renderAll();planner.resultReady({id:jobId,platform:source,month},{navigate:pendingQuestionNavigation});pendingQuestionNavigation=false;updateMap();$('form-status').textContent='Открыт исходный ряд выбранного спутника из готового расчёта.';}
 }else{invalidate();if(source==='all')$('form-status').textContent='Подберите условия или выберите один спутник для ручного анализа.';}
 matrixPanel.refresh();revisions.refresh();publishContext();
});
$('focus-month').addEventListener('change',()=>selectMonth($('focus-month').value));
$('series-mode').addEventListener('change',renderAll);
$('export-image').addEventListener('click',exportImage);
$('map-mode').addEventListener('change',()=>{stopPlaying();mapMode=$('map-mode').value;mapYear=null;frame=0;renderAll();updateMap();});
$('retry-map').addEventListener('click',updateMap);
for(const id of ['compare-year-a','compare-year-b'])$(id).addEventListener('change',()=>{compareYearA=$('compare-year-a').value;compareYearB=$('compare-year-b').value;if(mapYear)mapYear=null;renderAll();updateMap();});
$('compare-map-a').addEventListener('click',()=>showYearOnMap(compareYearA));$('compare-map-b').addEventListener('click',()=>showYearOnMap(compareYearB));$('calendar-anomalies').addEventListener('change',renderCalendar);
$('day-range').addEventListener('input',()=>selectFrame(Number($('day-range').value)));
$('reset-day').addEventListener('click',()=>selectFrame(0));$('play-days').addEventListener('click',play);
$('clear-focus-range').addEventListener('click',()=>{clearRangeFocus();frame=0;renderAll();updateMap();publishContext();});
$('last-month').addEventListener('click',()=>selectMonth(sourceRows().filter(r=>r.cells!==null).at(-1)?.month));
$('fit-area').addEventListener('click',()=>showBounds());
$('basemap').addEventListener('click',()=>{const active=$('basemap').getAttribute('aria-pressed')!=='true';$('basemap').setAttribute('aria-pressed',active);$('basemap').textContent=active?'Обзор':'Спутник';if(active)satellite.addTo(map);else satellite.remove();});
$('method-open')?.addEventListener('click',openMethod);$('provenance-open').addEventListener('click',openMethod);$('method-close').addEventListener('click',()=>$('method-dialog').close());
$('method-dialog').addEventListener('click',event=>{if(event.target===$('method-dialog'))$('method-dialog').close();});
for(const tab of root.querySelectorAll('[data-view]')){tab.tabIndex=tab.dataset.view===view?0:-1;tab.addEventListener('click',()=>activateTab(tab.dataset.view));tab.addEventListener('keydown',event=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...root.querySelectorAll('[data-view]')],index=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;activateTab(tabs[next].dataset.view);tabs[next].focus();});}
for(const button of root.querySelectorAll('[data-step]'))button.addEventListener('click',()=>{step=button.dataset.step;syncStepControls();renderChart();});
function download(url){const link=document.createElement('a');link.href=url;link.download='';root.append(link);link.click();link.remove();}
$('export-csv').addEventListener('click',()=>{if(view==='matrix')matrixPanel.exportData('csv');else if(jobId)download(`/api/v1/analyses/${jobId}/export?format=csv`);});$('export-json').addEventListener('click',()=>{if(view==='matrix')matrixPanel.exportData('json');else if(jobId)download(`/api/v1/analyses/${jobId}/export?format=json`);});
$('share').addEventListener('click',async()=>{try{await bridge.navigate?.('analysis',{share:true,state:getState()});}catch(error){$('error-banner').hidden=false;$('error-banner').textContent=error.message;}});
$('study-config-retry').addEventListener('click',async()=>{const snapshot=getState();$('study-config-retry').disabled=true;try{await activate({state:snapshot,context:snapshot.context,run:false});}finally{$('study-config-retry').disabled=false;}});
$('show-atlas').addEventListener('click',()=>bridge.navigate?.('atlas',{context:getState().context,from:'analysis',analysisState:getState()}));
$('draw-area').addEventListener('click',()=>{if(busy)return;drawing=!drawing;drawStart=null;$('draw-instruction').hidden=!drawing;map.getContainer().style.cursor=drawing?'crosshair':'';if(drawing){$('analysis-map').focus({preventScroll:true});$('analysis-map').scrollIntoView({block:'center'});}});
map.on('click',event=>{if(!active||busy||!drawing)return;const point=event.latlng;if(!drawStart){drawStart=point;return;}const a=drawStart,b=point;const bbox=[Math.min(a.lng,b.lng),Math.min(a.lat,b.lat),Math.max(a.lng,b.lng),Math.max(a.lat,b.lat)];['west','south','east','north'].forEach((k,i)=>$(k).value=bbox[i].toFixed(5));cancelTerritorySearch();territorySelected=true;clearShape();$('preset').value='custom';drawing=false;drawStart=null;$('draw-instruction').hidden=true;map.getContainer().style.cursor='';showBounds(false);invalidate();publishContext();});
root.addEventListener('keydown',event=>{if(event.key==='Escape'){drawing=false;drawStart=null;$('draw-instruction').hidden=true;map.getContainer().style.cursor='';}});
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(active&&result)renderAll();},120);}).observe($('workbench'));

async function initialize(){
 if(settings)return;
 if(!settingsPromise)settingsPromise=request('/api/v1/config').then(value=>{settings=value;$('end').max=settings.end;$('archive-info').textContent=`${n(settings.rows/1e6)} млн записей · архив с 2000 года`;const preset=selectedPreset();if(territorySelected&&preset)['west','south','east','north'].forEach((key,i)=>$(key).value=preset.bbox[i]);showBounds();}).catch(error=>{settingsPromise=null;throw error;});
 return settingsPromise;
}
function displayBounds(roi){
 const box=Array.isArray(roi.bbox)?clone(roi.bbox):null;
 if(!roi.circle||!box||box.length!==4||!box.every(Number.isFinite))return box;
 const center=roi.circle.center?.[0];
 if(Number.isFinite(center)){const shift=360*Math.round(((box[0]+box[2])/2-center)/360);box[0]-=shift;box[2]-=shift;}
 if(box[0]<-180||box[2]>180||box[0]>box[2]){box[0]=-180;box[2]=180;}
 return box;
}
function applyContext(context){
 if(!context)return;
 if(busy){++generation;setBusy(false);pendingAnalysis=null;}
 const roi=context.roi;
 if(roi){
  cancelTerritorySearch();territorySelected=true;clearShape();const preset=roi.preset&&[...$('preset').options].some(option=>option.value===roi.preset)?roi.preset:'custom';$('preset').value=preset;
  const bbox=preset==='sko'?settings?.presets.find(item=>item.id==='sko')?.bbox:displayBounds(roi);
  if(Array.isArray(bbox)&&bbox.length===4)['west','south','east','north'].forEach((key,i)=>$(key).value=bbox[i]);
  if(preset!=='sko'){roiGeometry=clone(roi.geometry?.type==='Feature'?roi.geometry.geometry:roi.geometry)||null;roiCircle=roiGeometry?null:clone(roi.circle)||null;roiName=String(roi.name||'');roiSource=String(roi.source||'');}
 }else if(Object.hasOwn(context,'roi')){cancelTerritorySearch();territorySelected=false;clearShape();$('preset').value='custom';['west','south','east','north'].forEach((key,i)=>$(key).value=[-180,-85,180,85][i]);$('analysis-territory-query').value='';$('analysis-territory-status').textContent='';}
 if(context.history){if(context.history.start)$('start').value=context.history.start;if(context.history.end)$('end').value=context.history.end;}
 if(context.baseline){if(context.baseline.start!==undefined)$('baseline-start').value=context.baseline.start;if(context.baseline.end!==undefined)$('baseline-end').value=context.baseline.end;}
 if(context.grid_km!==undefined&&[2,5,10,20].includes(Number(context.grid_km)))$('grid').value=context.grid_km;
 if(context.quality)$('include-nrt').checked=context.quality==='all';
 if(['all','D','N'].includes(context.daynight))$('daynight').value=context.daynight;
 if(context.platform==='all'||labels[context.platform]){source=context.platform;$('platform').value=source;}
 retainedFocus=clone(context.focus)||null;rangeFocus=isRangeFocus(retainedFocus)?clone(retainedFocus):null;showBounds();invalidate();
 if(source==='all')$('form-status').textContent='Передано «все спутники». План предложит отдельный ряд; для ручного расчёта выберите один спутник.';
}
function applyFocus(focus){
 if(!focus||!result)return;
 if(focus.start<result.config.start||focus.end>result.config.end){retainedFocus=null;rangeFocus=null;return;}
 rangeFocus=isRangeFocus(focus)?clone(focus):null;
 const key=focus.start?.slice(0,7);
 if(sourceRows().some(row=>row.month===key)){month=key;$('focus-month').value=key;if(focus.grain==='day')frame=Math.max(0,frameDates().indexOf(focus.start)+1);}
 if(rangeFocus){mapYear=null;frame=0;mapMode='activity';$('map-mode').value='activity';}
 else if(focus.grain==='year'&&focus.basis==='ISO'){const d=new Date(focus.start+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+3-(d.getUTCDay()+6)%7);const year=String(d.getUTCFullYear());if(result.weekly_profiles?.[source]?.years?.[year])mapYear=year;}
}
function focusState(){
 if(rangeFocus)return clone(rangeFocus);
 if(!result||!month)return clone(retainedFocus)||{start:$('start').value,end:$('end').value,basis:'UTC',grain:'month'};
 if(mapYear){const metrics=result.weekly_profiles?.[source]?.year_metrics?.[mapYear];return {start:metrics?.start_date||`${mapYear}-01-01`,end:metrics?.end_date||`${mapYear}-12-31`,basis:'ISO',grain:'year'};}
 const dates=frameDates();return frame?{start:dates[frame-1],end:dates[frame-1],basis:'UTC',grain:'day'}:{start:dates[0],end:dates.at(-1),basis:'UTC',grain:'month'};
}
function getState(){
 const config=result?.config||formConfig(),geometry=config.circle?null:config.geometry||(config.preset==='sko'?(roiGeometry||settings?.region_geometry):roiGeometry),circle=config.circle||roiCircle;
 const matrix=matrixPanel.getState();
 const study=planner.getState();
 return {context:{roi:territorySelected?{preset:config.preset,name:areaName(config),bbox:clone(config.bbox),...(geometry?{geometry:clone(geometry.type==='Feature'?geometry.geometry:geometry)}:{}),...(circle?{circle:clone(circle)}:{}),source:config.roi_source||roiSource||(config.preset==='sko'?'canonical-sko':'user')}:null,history:{start:config.start,end:config.end},baseline:{start:config.baseline_start,end:config.baseline_end},focus:focusState(),platform:source,quality:config.quality,daynight:config.daynight,grid_km:config.grid_km,study},study,revisions:revisions.getState(),tab:view,step,month,mapMode,mapYear,compareYearA,compareYearB,seriesMode:$('series-mode').value,analysisId:result?jobId:null,matrixId:matrix.result?matrix.id:null,matrixState:{platform:matrix.platform,mode:matrix.mode,pair:matrix.pair}};
}
async function activate(options={}){
 const current=++activation;active=true;
 const residentResult=result,residentId=jobId,residentView=result?getState():null;
 setBootstrapPending(true);
 const intended=options.context||options.state?.context;
 let contextApplied=false;
 try{
  if(intended){applyContext(intended);planner.restore(intended.study||options.state?.study||planner.getState());contextApplied=true;setBootstrapPending(true);}
  await initialize();
  if(!active||current!==activation)return;
  setBootstrapPending(false);
  $('study-config-retry').hidden=true;$('error-banner').hidden=true;
  const saved=options.state||options,matching=saved.analysisId&&saved.analysisId===jobId&&result;
  const incoming=options.context||saved.context;
  if(incoming){applyContext(incoming);contextApplied=true;}
  else if(matching&&saved.context){if(labels[saved.context.platform]){source=saved.context.platform;$('platform').value=source;}retainedFocus=clone(saved.context.focus);applyFocus(retainedFocus);}
  planner.restore(incoming?.study||saved.study||saved.context?.study||planner.getState());planner.resume();revisions.resume();matrixPanel.resume();
  pendingViewState=incoming||options.run?saved:null;
  if(result)restoreView(saved);
  if(options.tab||saved.tab)activateTab(options.tab||saved.tab);
  map.invalidateSize({pan:false});
  let residentReused=false;
  if(territorySelected&&!result&&residentResult&&(!saved.analysisId||saved.analysisId===residentId)&&sameScientificConfig(residentResult.config,formConfig())){
   result=residentResult;jobId=residentId;residentReused=true;
   pendingViewState={...residentView,...saved};
   if(incoming?.focus&&JSON.stringify(incoming.focus)!==JSON.stringify(residentView?.context?.focus)){delete pendingViewState.month;delete pendingViewState.mapYear;}
   await displayResult();if(!active||current!==activation)return getState();$('form-status').textContent=source==='all'?'Расчёт сохранён. Выберите один спутник для просмотра; платформы не суммируются.':'Восстановлен готовый расчёт этих условий; новый запрос не выполнялся.';
  }
  if(saved.analysisId&&!result){
   const restoringGeneration=generation;
   const intended=territorySelected?clone(formConfig()):null;
   try{const job=await request(`/api/v1/analyses/${encodeURIComponent(saved.analysisId)}`);if(current!==activation||!active||restoringGeneration!==generation)return;if(job.status!=='done'||!job.result)throw new Error('Сохранённый расчёт ещё не готов.');if(intended&&(!sameScientificConfig(job.result.config,intended)||!sameScientificConfig(formConfig(),intended))){rejectCachedResult('Сохранённый расчёт относится к другой территории или другим научным параметрам. Данные не показаны; выполните новый расчёт.');return getState();}jobId=saved.analysisId;acceptResult(job.result);await displayResult();if(!active||current!==activation||restoringGeneration!==generation)return getState();$('form-status').textContent='Восстановлен сохранённый расчёт; новый запрос не выполнялся.';}
   catch(error){if(current===activation){$('form-status').textContent='Сохранённый расчёт недоступен. Параметры восстановлены; нажмите «Построить анализ», чтобы рассчитать заново.';$('error-banner').hidden=false;$('error-banner').textContent=error.message;}}
  }
  else if(options.run===true&&!result){pendingAnalysis=startAnalysis();await pendingAnalysis;}
  else if(result&&!residentReused&&source!=='all'){showResultSurface(true);renderAll();planner.resultReady({id:jobId,platform:source,month});await updateMap();}
  else if(!result&&source!=='all')$('form-status').textContent=territorySelected?'Подберите условия по архиву либо запустите расчёт с ручными настройками.':'Найдите территорию или выделите область на карте.';
  if(current!==activation||!active)return;
  const matrixId=saved.matrixId||(residentReused?residentView?.matrixId:null),matrixState=saved.matrixState||(residentReused?residentView?.matrixState:null);
  if(matrixId&&result&&matrixId!==matrixPanel.getState().id)await matrixPanel.restore(matrixId,matrixState);
  await revisions.restore(saved.revisions||(residentReused?residentView?.revisions:null));
  matrixPanel.setVisible(view==='matrix');
  syncTerritoryControls();
  return getState();
 }catch(error){if(current===activation&&active){if(!settings&&intended&&!contextApplied){applyContext(intended);planner.restore(intended.study||options.state?.study||planner.getState());}planner.resume();setBootstrapPending(false);$('error-banner').hidden=false;$('error-banner').textContent='Сервис анализа недоступен: '+error.message;$('study-config-retry').hidden=Boolean(settings);$('form-status').textContent='Территория и условия сохранены. Повторите подключение к архиву.';if(!settings)$('archive-info').textContent='Подключение к архиву недоступно';}return getState();}
}
function restoreView(state){
 if(!state||!result)return;
 if(['month','week','day'].includes(state.step)){step=state.step;syncStepControls();}
 if(state.month&&sourceRows().some(row=>row.month===state.month)){month=state.month;$('focus-month').value=month;}
 if(['activity','anomaly'].includes(state.mapMode)){mapMode=rangeFocus?'activity':state.mapMode;$('map-mode').value=mapMode;}
 if(!rangeFocus&&state.mapYear&&result.weekly_profiles?.[source]?.years?.[state.mapYear])mapYear=String(state.mapYear);
 if(state.compareYearA)compareYearA=String(state.compareYearA);if(state.compareYearB)compareYearB=String(state.compareYearB);
 if(['raw','calibrated'].includes(state.seriesMode))$('series-mode').value=state.seriesMode;
}
function deactivate(){
 active=false;++activation;++generation;cancelTerritorySearch();analysisAbort?.abort();analysisAbort=null;if(busy)setBusy(false);planner.pause();revisions.pause();stopPlaying();++mapGeneration;drawing=false;drawStart=null;$('draw-instruction').hidden=true;map.getContainer().style.cursor='';$('method-dialog').close();matrixPanel.pause();
}

/* Lifecycle is owned by the application shell; importing this module is inert. */
return {activate,deactivate,getState};
}
