const $ = id => document.getElementById(id);
const views = new Map();
const controllers = new Map();
const loading = new Map();
const viewNames = new Set(['atlas','analysis','cases']);
const platformNames = new Set(['all','Aqua','Terra','Suomi-NPP','NOAA-20','NOAA-21']);
const storageKey = 'nasa-space-apps-context-v1';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
let currentView = 'atlas', navigation = 0, statusTimer;
let context = { roi:null, history:{start:'2020-01-01',end:'2025-12-31'}, baseline:{start:2020,end:2023}, focus:null, platform:'all', quality:'sp', daynight:'all', study:null };
let restored = null;
try { restored = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* An unavailable storage does not prevent the app. */ }

function mergeContext(patch = {}) {
  const next = {...context,...clone(patch)};
  for (const key of ['history','baseline']) next[key] = {...context[key],...(patch[key] || {})};
  if (!platformNames.has(next.platform)) next.platform = 'all';
  context = next;
  renderHeaderContext();
  return clone(context);
}
function notice(message) {
  clearTimeout(statusTimer);$('shell-status').textContent=message;$('shell-status').hidden=false;
  statusTimer=setTimeout(()=>$('shell-status').hidden=true,9000);
}
function capture() {
  const states = {};
  for (const [name,controller] of controllers) states[name] = controller.getState?.();
  return {version:1,view:currentView,context:clone(context),states};
}
function persist() {
  const snapshot=capture();
  try { const value=JSON.stringify(snapshot);if(value.length<1500000)localStorage.setItem(storageKey,value); } catch { /* Private browsing and storage limits are supported. */ }
  return snapshot;
}
function bridgeFor(owner) {
  return {
    navigate, notice,
    getContext:()=>clone(context),
    setContext:patch=>{if(isActive(owner)){mergeContext(patch);persist();}},
    isActive,
    setLocalHash:hash=>{if(isActive('atlas')){const url=new URL(location.href);url.hash=hash;history.replaceState(history.state,'',url);renderHeaderContext();}},
  };
}
function isActive(name) {return name==='atlas' ? currentView==='atlas'||currentView==='cases' : currentView===name;}
function renderHeaderContext() {
  const legacy=currentView==='atlas'&&['#season-calendar','#correlations'].includes(location.hash);
  const label=currentView==='cases'?'Кишкенеколь · 12.04.2025':legacy?'Исследование СКО · 2020–2025':context.roi?.name||'Выберите территорию';
  $('app-context').textContent=label;$('app-context').title=label;
}

async function fragment(path, selector) {
  const response=await fetch(path,{cache:'no-cache'});
  if(!response.ok)throw new Error(`Не удалось открыть инструмент (HTTP ${response.status}).`);
  const doc=new DOMParser().parseFromString(await response.text(),'text/html');
  const root=document.createElement('div');
  if(selector){const content=doc.querySelector(selector);if(!content)throw new Error('Не найден интерфейс инструмента.');root.append(content);}
  else root.append(...doc.body.childNodes);
  for(const script of root.querySelectorAll('script'))script.remove();
  return root;
}
async function ensureView(name) {
  const key=name==='cases'?'atlas':name;
  if(controllers.has(key))return controllers.get(key);
  if(loading.has(key))return loading.get(key);
  const promise=(async()=>{
    let root,controller;
    if(key==='atlas'){
      root=await fragment('atlas.html');root.id='atlas-view';root.className='app-view atlas-view';
      $('app-outlet').append(root);views.set('atlas',root);visibility();
      const [{mountAtlas},{mountCorrelations},{mountBurnCase}]=await Promise.all([import('./app.js?v=file-matrix'),import('./correlations.js?v=shell'),import('./burn-case.js?v=shell')]);
      controller=mountAtlas(root,bridgeFor('atlas'));
      controllers.set('atlas',controller);
      mountCorrelations(root);mountBurnCase(root);
    }else{
      root=await fragment('analysis-view.html');root.id='analysis-view';root.className='app-view analysis-workbench';
      $('app-outlet').append(root);views.set('analysis',root);visibility();
      const {mountWorkbench}=await import('./workbench.js?v=dark');controller=mountWorkbench(root,bridgeFor('analysis'));controllers.set('analysis',controller);
    }
    visibility();return controller;
  })();
  loading.set(key,promise);
  try{return await promise;}finally{loading.delete(key);}
}
function visibility() {
  const atlas=currentView==='atlas'||currentView==='cases';
  $('atlas-styles').disabled=!atlas;
  document.body.dataset.appView=currentView;
  for(const [name,node] of views){const visible=atlas?name==='atlas':name==='analysis';node.hidden=!visible;node.inert=!visible;}
  for(const link of document.querySelectorAll('[data-app-view]')){
    const selected=link.dataset.appView===currentView;
    if(selected&&link.closest('.app-nav'))link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  }
  document.title=`NASA Space Apps · ${currentView==='analysis'?'Анализ территории':currentView==='cases'?'Кейсы':'Атлас'}`;
  renderHeaderContext();
  $('shell-loading').hidden=views.has(atlas?'atlas':'analysis');
}
function urlFor(view) {const url=new URL(location.href);url.search='';url.searchParams.set('view',view);url.hash=view==='cases'?'kishkenekol-case':'';return url;}
async function navigate(view,payload={}) {
  if(!viewNames.has(view))return;
  if(payload.share)return share(view,payload.state);
  if(!payload.fromHistory&&!payload.context&&!payload.state){
    if(view==='analysis'&&(currentView==='atlas'||currentView==='cases'))payload={...payload,context:analysisContext(),run:false};
    else if(view==='atlas'&&currentView==='analysis')payload={...payload,context:controllers.get('analysis')?.getState?.().context||clone(context)};
  }
  if(view==='analysis'&&currentView==='atlas'&&!payload.context&&!payload.state&&!payload.snapshot&&!payload.fromHistory&&controllers.get('atlas')?.getState?.().context?.roi){
    payload={...payload,context:analysisContext(),run:false,from:payload.from||'atlas'};
  }
  const before=persist();
  const oldKey=currentView==='cases'?'atlas':currentView;
  controllers.get(oldKey)?.deactivate?.();
  const token=++navigation;currentView=view;
  if(payload.context)mergeContext(payload.context);
  visibility();
  if(!payload.fromHistory){
    history.replaceState({...history.state,snapshot:before},'',location.href);
    // Keep the destination intent even if the user goes Back before its lazy
    // controller finishes loading. Forward must not reopen default parameters.
    history.pushState({app:true,view,snapshot:{version:1,view,context:clone(context),states:{}}},'',urlFor(view));
  }
  try{
    const controller=await ensureView(view);
    if(token!==navigation)return;
    const state=payload.state||payload.snapshot?.states?.[view==='cases'?'atlas':view];
    const options={...payload,view,state};
    if(view==='cases')options.caseId=payload.caseId||'kishkenekol-2025-04-12';
    await controller.activate?.(options);
    if(token!==navigation)return;
    const local=controller.getState?.();if(local?.context)mergeContext(local.context);
    $('shell-loading').hidden=true;
    const settled=persist();
    history.replaceState({...history.state,app:true,view,snapshot:settled},'',location.href);
    if(payload.from==='analysis')notice('Атлас показывает исходные детекции. Территория и даты перенесены; шкала Aqua к пикселям не применяется.');
  }catch(error){if(token===navigation){notice(error.message);$('shell-loading').textContent='Инструмент не загрузился. Выберите другой раздел или обновите страницу.';$('shell-loading').hidden=false;}}
}
function analysisContext() {
  const selected=controllers.get('atlas')?.getAnalysisContext?.();
  if(selected)return selected;
  const from=controllers.get('atlas')?.getState?.().context || {};
  const next={...clone(context),...clone(from)};
  next.history={...context.history};next.baseline={...context.baseline};
  if(next.focus&&(next.focus.end>next.history.end||next.focus.start<next.history.start)){
    next.focus=null;notice('Дата карты вне выбранной истории. Период исследования сохранён; измените его в условиях сравнения.');
  }
  return next;
}
function portableStudy(study){
  if(!study||typeof study!=='object')return null;
  return {question:study.question,optionId:study.optionId,stage:study.stage};
}
function portableRevisions(value){
  if(!value||!/^[0-9a-f]{32}$/.test(value.beforeId||'')||!/^[0-9a-f]{32}$/.test(value.afterId||''))return null;
  return {beforeId:value.beforeId,afterId:value.afterId,question:['anomaly','compare-years','sensor-transition'].includes(value.question)?value.question:'anomaly',platform:platformNames.has(value.platform)&&value.platform!=='all'?value.platform:'NOAA-20',month:/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month||'')?value.month:null,seriesMode:value.seriesMode==='calibrated'?'calibrated':'raw',years:Array.isArray(value.years)?value.years.map(String).filter(year=>/^\d{4}$/.test(year)).slice(0,2):[],open:true};
}
async function share(view,state) {
  try{
    const selected=state||controllers.get(view==='cases'?'atlas':view)?.getState?.();
    const sourceContext=selected?.context||context;
    const study=portableStudy(selected?.study||sourceContext.study);
    const pair=selected?.shareRevisions?portableRevisions(selected.revisions):null;
    const portable=pair?{version:1,revisions:pair}:{version:1,context:{...sourceContext,study},study,atlasStudy:selected?.atlasStudy,tab:selected?.tab,step:selected?.step,month:selected?.month,mapMode:selected?.mapMode,mapYear:selected?.mapYear,compareYearA:selected?.compareYearA,compareYearB:selected?.compareYearB,seriesMode:selected?.seriesMode,analysisId:selected?.analysisId,matrixId:selected?.matrixId,matrixState:selected?.matrixState};
    let encoded=JSON.stringify(portable);const url=urlFor(view);
    if(encodeURIComponent(encoded).length>6000){
      if(!selected?.analysisId)throw new Error('Для ссылки с подробной границей сначала завершите расчёт территории.');
      url.searchParams.set('analysis_id',selected.analysisId);encoded=JSON.stringify({...portable,context:{...portable.context,roi:null}});
    }
    url.searchParams.set('state',encoded);history.replaceState({...history.state,app:true,view},'',url);
    try{await navigator.clipboard.writeText(url.href);notice(pair?'Ссылка на две сохранённые версии скопирована.':'Ссылка на выбранный контекст скопирована.');}catch{notice('Ссылка с выбранным контекстом находится в адресной строке.');}
  }catch(error){notice(error.message);}
}
function contextFromLegacy(value) {
  return {roi:{preset:value.preset||'custom',bbox:value.bbox,name:value.roi_name||'',geometry:value.geometry,circle:value.circle,source:value.roi_source},history:{start:value.start,end:value.end},baseline:{start:value.baseline_start,end:value.baseline_end},platform:value.platform||'NOAA-20',quality:value.quality||'sp',daynight:value.daynight||'all',grid_km:value.grid_km};
}
document.querySelectorAll('[data-app-view]').forEach(link=>link.addEventListener('click',event=>{
  if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  event.preventDefault();navigate(link.dataset.appView);
}));
$('app-method-open').addEventListener('click',()=>$('app-method').showModal());
$('app-method-close').addEventListener('click',()=>$('app-method').close());
$('app-method-validation').addEventListener('click',()=>{$('app-method').close();navigate('analysis',{tab:'validation',...(currentView!=='analysis'&&context.roi?{context:analysisContext(),run:false}:{} )});});
$('app-method-atlas').addEventListener('click',async()=>{$('app-method').close();await navigate('atlas');controllers.get('atlas')?.openPanel?.('#observations');views.get('atlas')?.querySelector('#open-layers')?.click();});
new ResizeObserver(()=>{document.documentElement.style.setProperty('--app-header-height',`${Math.ceil($('app-header').getBoundingClientRect().height)}px`);}).observe($('app-header'));
window.addEventListener('beforeunload',persist);
window.addEventListener('hashchange',renderHeaderContext);
window.addEventListener('popstate',event=>{
  const snapshot=event.state?.snapshot;const view=event.state?.view||new URL(location.href).searchParams.get('view')||'atlas';
  if(snapshot?.context)mergeContext(snapshot.context);
  navigate(viewNames.has(view)?view:'atlas',{fromHistory:true,snapshot,context:snapshot?.context});
});

(async()=>{
  try{
    const url=new URL(location.href);let state=null;
    if(url.searchParams.has('state'))state=JSON.parse(url.searchParams.get('state'));
    const legacy=url.searchParams.has('analysis')?JSON.parse(url.searchParams.get('analysis')):null;
    let view=url.searchParams.get('view')||(legacy?'analysis':url.hash==='#kishkenekol-case'?'cases':restored?.view||'atlas');
    if(!viewNames.has(view))view='atlas';
    if(state?.version!==1)state=null;
    if(state?.context)mergeContext(state.context);else if(legacy)mergeContext(contextFromLegacy(legacy));else if(restored?.version===1&&restored.context)mergeContext(restored.context);
    const pair=portableRevisions(state?.revisions);
    if(pair){
      view='analysis';state.revisions=pair;state.analysisId=null;
      try{
        const response=await fetch(`/api/v1/analyses/${pair.afterId}/snapshot`);if(!response.ok)throw new Error('Сохранённая версия недоступна.');
        const snapshot=await response.json();if(!snapshot.config)throw new Error('Параметры сохранённой версии не записаны.');
        const canonical=contextFromLegacy({...snapshot.config,platform:pair.platform});canonical.study={question:pair.question,stage:'result'};canonical.focus=null;
        mergeContext(canonical);state.context=clone(context);state.study=canonical.study;state.month=pair.month;state.seriesMode=pair.seriesMode;state.compareYearA=pair.years[0];state.compareYearB=pair.years[1];
        state.tab=pair.question==='compare-years'?'compare':pair.question==='sensor-transition'?'validation':'calendar';
        if(snapshot.method_status==='current')state.analysisId=pair.afterId;
      }catch{notice('Основной расчёт не восстановлен. Откроем доступные архивные значения пары без нового расчёта.');}
    }
    const id=pair?null:url.searchParams.get('analysis_id');
    if(id&&/^[0-9a-f]{32}$/.test(id)){
      const response=await fetch(`/api/v1/analyses/${id}`);if(!response.ok)throw new Error('Сохранённый расчёт больше недоступен. Выберите территорию заново.');
      const job=await response.json();if(job.status!=='done')throw new Error('Сохранённый расчёт ещё не завершён.');
      const cfg=job.result.config,canonical=contextFromLegacy({...cfg,platform:state?.context?.platform}),provided=state?.context||{};
      // Large shared geometries may be restored by ID. Explicit shared filters
      // still reach the workbench, which checks them against the saved result.
      mergeContext({...canonical,...provided,roi:provided.roi||canonical.roi,
        history:{...canonical.history,...provided.history},baseline:{...canonical.baseline,...provided.baseline}});
    }
    currentView=view;history.replaceState({app:true,view,snapshot:null},'',location.href);visibility();
    const bootToken=navigation;
    const controller=await ensureView(view);
    if(bootToken!==navigation)return;
    const saved=state||restored?.states?.[view==='cases'?'atlas':view]||(id?{context:clone(context),analysisId:id}:undefined);
    if(id&&saved)saved.analysisId=id;
    await controller.activate?.({view,state:saved,context:(state||legacy||id)?context:undefined,run:Boolean(legacy),caseId:view==='cases'?'kishkenekol-2025-04-12':undefined});
    if(bootToken!==navigation)return;
    const local=controller.getState?.();if(local?.context)mergeContext(local.context);persist();
  }catch(error){notice(error.message);$('shell-loading').textContent='Выберите раздел и территорию, чтобы продолжить.';}
})();
