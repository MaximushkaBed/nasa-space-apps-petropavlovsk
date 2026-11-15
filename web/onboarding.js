import { preserveLanguage } from './i18n.js';

const seenKey = 'nasa-space-apps-onboarding-v1';
const resumeKey = 'nasa-space-apps-tour-v1';
const exampleId = '7ad1819ace34dfa2fd5a498a7eda3db7';
const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
const write = (storage, key, value) => { try { value == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ } };
const welcome = document.createElement('aside');
welcome.className = 'onboarding-panel onboarding-welcome';
welcome.id = 'onboarding-welcome'; welcome.hidden = true;
welcome.setAttribute('aria-labelledby', 'onboarding-title');
welcome.innerHTML = `<button class="onboarding-close" type="button" aria-label="Скрыть подсказку">×</button>
  <span class="onboarding-kicker">Начало работы</span><h2 id="onboarding-title">Сравните активность с историей региона</h2>
  <p>Посмотрите готовый результат или начните свой анализ. Короткие подсказки покажут основные шаги.</p>
  <p id="onboarding-status" role="status" aria-live="polite"></p>
  <div class="onboarding-actions"><button type="button" class="onboarding-primary" id="onboarding-demo">Готовый пример</button><button type="button" id="onboarding-own">Свой анализ</button></div>
  <button type="button" class="onboarding-dismiss" id="onboarding-skip">Позже · подсказки доступны в «Как пользоваться»</button>`;
const card = document.createElement('aside');
card.className = 'onboarding-panel onboarding-card';
card.id = 'onboarding-card'; card.hidden = true;
card.setAttribute('aria-labelledby', 'onboarding-step-title');
card.innerHTML = `<button class="onboarding-close" type="button" aria-label="Скрыть подсказки">×</button><span id="onboarding-progress" class="onboarding-kicker"></span><h2 id="onboarding-step-title"></h2><p id="onboarding-step-text"></p><p id="onboarding-wait" class="onboarding-muted" role="status"></p><div class="onboarding-actions"><button type="button" id="onboarding-back">Назад</button><button type="button" class="onboarding-primary" id="onboarding-next">Дальше</button></div>`;
document.body.append(welcome, card);
const flows = {
  demo: [
    {target:'#anomaly-value',title:'Отклонение от исторического уровня',text:'Плюс — активность выше исторического уровня, минус — ниже. Это спутниковые сигналы, не число пожаров.',ready:'#study-results:not([hidden])'},
    {target:'#study-assessment',title:'Основания результата',text:'Здесь указано, хватает ли данных для сравнения. Подробности — в «Основаниях и ограничениях».'},
    {target:'#focus-month',title:'Другой месяц',text:'Выберите месяц здесь или в календаре. Значения и пояснение обновятся для выбранного месяца.'},
    {target:'#analysis-territory-search',fallback:'#preset',workflow:'territory',title:'Ваша территория',text:'Для своего анализа найдите страну или регион либо выделите участок на карте.'},
  ],
  setup: [
    {target:'#analysis-territory-search',fallback:'#preset',workflow:'territory',title:'1. Территория',text:'Найдите страну или регион либо выделите свой участок на карте. Расчёт будет относиться к этой границе.'},
    {target:'#study-question',workflow:'task',title:'2. Результат анализа',text:'Выберите отклонение от сезонной нормы, сравнение лет или сопоставимость данных спутников.'},
    {target:'#study-plan-request',workflow:'conditions',title:'3. Данные для анализа',text:'Нажмите «Проверить доступные данные», чтобы увидеть доступные спутники и годы. Выберите, какие данные использовать. Расчёт пока не запускается.'},
    {target:'#run',fallback:'#study-applied',workflow:'conditions',title:'4. Расчёт и результат',text:'Проверьте выбранный спутник и годы, затем нажмите «Построить анализ». Готовый результат можно сохранить и сравнить с другой версией.',wait:'Кнопка расчёта появится после выбора данных.'},
  ],
};
let current = null, highlighted, observed, raf, returnFocus, demoRequest, revealPending = false, workflowPending = false;
const visible = selector => [...document.querySelectorAll(selector)].find(node => {const box=node.getBoundingClientRect();return box.width>0&&box.height>0;});
const clamp = (value, low, high) => Math.max(low, Math.min(value, Math.max(low, high)));
function clearTarget(){highlighted?.classList.remove('onboarding-target');highlighted=null;}
function place(){
  if(!current||card.hidden)return;
  const step=flows[current.flow][current.index];
  if(workflowPending&&step.workflow){
    const view=document.querySelector('.analysis-workbench[data-workflow-ready="true"][data-workflow-active="true"]');
    if(view&&visible('#analysis-settings-toggle')){workflowPending=false;document.dispatchEvent(new CustomEvent('nasa:analysis-settings',{detail:{open:true,step:step.workflow}}));}
  }
  const target=(!step.ready||visible(step.ready))&&(visible(step.target)||(step.fallback&&visible(step.fallback)));
  if(target!==highlighted){clearTarget();highlighted=target||null;highlighted?.classList.add('onboarding-target');}
  const top=document.querySelector('#app-header').getBoundingClientRect().bottom+10;
  if(highlighted&&revealPending){
    revealPending=false;const box=highlighted.getBoundingClientRect();
    if(box.top<top||box.bottom>innerHeight-12)highlighted.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  }
  card.querySelector('#onboarding-wait').textContent=target?'':step.wait||'Подсказка появится рядом с элементом после загрузки.';
  const w=card.offsetWidth,h=card.offsetHeight,gap=10;
  let x=innerWidth-w-12,y=innerHeight-h-12;
  if(highlighted){
    const box=highlighted.getBoundingClientRect();
    if(box.bottom>=top&&box.top<innerHeight){
      if(box.right+gap+w<=innerWidth-12){x=box.right+gap;y=box.top;}
      else if(box.left-gap-w>=12){x=box.left-gap-w;y=box.top;}
      else if(box.bottom+gap+h<=innerHeight-12){x=box.left;y=box.bottom+gap;}
      else if(box.top-gap-h>=top){x=box.left;y=box.top-gap-h;}
    }
  }
  card.style.left=clamp(x,12,innerWidth-w-12)+'px';card.style.top=clamp(y,top,innerHeight-h-12)+'px';
}
function renderStep(){
  const list=flows[current.flow],step=list[current.index];
  card.querySelector('#onboarding-progress').textContent=`${current.index+1} / ${list.length}`;
  card.querySelector('#onboarding-step-title').textContent=step.title;
  card.querySelector('#onboarding-step-text').textContent=step.text;
  card.querySelector('#onboarding-back').disabled=current.index===0;
  card.querySelector('#onboarding-next').textContent=current.index===list.length-1?current.flow==='demo'?'Свой анализ':'Готово':'Дальше';
  card.hidden=false;revealPending=true;workflowPending=Boolean(step.workflow);place();
}
function finish(){
  demoRequest?.abort();demoRequest=null;
  const restore=card.contains(document.activeElement)||welcome.contains(document.activeElement);
  current=null;revealPending=workflowPending=false;clearTarget();card.hidden=welcome.hidden=true;observed?.disconnect();observed=null;
  write(sessionStorage,resumeKey,null);write(localStorage,seenKey,true);
  if(restore&&returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
}
function start(flow,index=0){
  demoRequest?.abort();demoRequest=null;
  welcome.hidden=true;current={flow,index};write(localStorage,seenKey,true);
  observed?.disconnect();observed=new MutationObserver(()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(place);});
  observed.observe(document.querySelector('#app-outlet'),{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','disabled','data-workflow-ready','data-workflow-active','data-workflow-step','data-settings-open']});
  renderStep();
}
function ownStudy(){
  if(!visible('.analysis-workbench'))document.querySelector('#app-header a[data-app-view="analysis"]').click();
  start('setup');
}
function showWelcome(){
  returnFocus=document.activeElement;finish();welcome.querySelector('#onboarding-status').textContent='';welcome.hidden=false;
}
for(const node of [card,welcome])node.querySelector('.onboarding-close').addEventListener('click',finish);
card.querySelector('#onboarding-back').addEventListener('click',()=>{if(current.index>0){current.index--;renderStep();}});
card.querySelector('#onboarding-next').addEventListener('click',()=>{if(current.index+1<flows[current.flow].length){current.index++;renderStep();}else if(current.flow==='demo')ownStudy();else finish();});
welcome.querySelector('#onboarding-own').addEventListener('click',ownStudy);
welcome.querySelector('#onboarding-skip').addEventListener('click',finish);
document.querySelector('#app-tour-open').addEventListener('click',showWelcome);
document.addEventListener('pointerdown',event=>{if(!welcome.hidden&&!welcome.contains(event.target)&&!event.target.closest('#app-tour-open, #app-language, #app-language-mobile'))finish();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(!card.hidden||!welcome.hidden))finish();});
document.addEventListener('click',event=>{if(current&&event.target.closest('#app-header a[data-app-view], #analysis-settings-close, #run'))finish();});
document.addEventListener('nasa:analysis-drawing',event=>{if(event.detail?.active)finish();});
addEventListener('resize',place);addEventListener('scroll',place,{capture:true,passive:true});

welcome.querySelector('#onboarding-demo').addEventListener('click', async event => {
  const button = event.currentTarget, status = welcome.querySelector('#onboarding-status');
  demoRequest?.abort();const controller=new AbortController();demoRequest=controller;
  button.disabled = true; status.className = ''; status.textContent = 'Открываем готовое исследование. Новый расчёт не запускается.';
  try {
    const response = await fetch(`/api/v1/analyses/${exampleId}`,{signal:controller.signal});
    if (!response.ok) throw new Error('Пример сейчас недоступен. Можно начать своё исследование или повторить открытие.');
    const job = await response.json(); if(controller.signal.aborted||demoRequest!==controller||welcome.hidden)return;
    if (job.status !== 'done' || !job.result?.config) throw new Error('Пример пока не готов. Выберите «Своё исследование».');
    const result = job.result, c = result.config;
    const choices = result.monthly.filter(row => row.platform === 'Aqua' && row.comparison_status === 'ok' && row.baseline > 0);
    const month = choices.find(row => row.month === '2025-04')?.month || choices.at(-1)?.month;
    if (!month) throw new Error('В этом примере нет пригодного месяца для объяснения. Выберите «Своё исследование».');
    const context = {roi:{preset:c.preset,bbox:c.bbox,name:c.roi_name || 'Северо-Казахстанская область',...(c.geometry ? {geometry:c.geometry} : {}),...(c.circle ? {circle:c.circle} : {})},
      history:{start:c.start,end:c.end},baseline:{start:c.baseline_start,end:c.baseline_end},focus:null,platform:'Aqua',grid_km:c.grid_km,quality:c.quality,daynight:c.daynight,study:{question:'anomaly'}};
    const state = {version:1,context,analysisId:exampleId,month,tab:'calendar',seriesMode:'raw',study:{question:'anomaly'}};
    const url = new URL(location.href); url.search = ''; url.hash = '';
    url.searchParams.set('view','analysis'); url.searchParams.set('analysis_id',exampleId); url.searchParams.set('state',JSON.stringify(state));
    write(localStorage, seenKey, true); write(sessionStorage, resumeKey, {flow:'demo',index:0,navigation:true});
    location.assign(preserveLanguage(url));
  } catch (error) { if(error.name!=='AbortError'&&!welcome.hidden){status.className = 'onboarding-error'; status.textContent = error.message;} }
  finally { if(demoRequest===controller)demoRequest=null;button.disabled = false; }
});

// Consume only a deliberate transition into the ready example. Refreshes and
// ordinary navigation must never restart a dismissed or unfinished tour.
const resume=read(sessionStorage,resumeKey);
write(sessionStorage,resumeKey,null);
if(resume?.navigation===true&&flows[resume.flow]&&Number.isInteger(resume.index)&&resume.index>=0&&resume.index<flows[resume.flow].length)start(resume.flow,resume.index);
else{
  const url=new URL(location.href),shared=['state','analysis_id','analysis'].some(key=>url.searchParams.has(key));
  if(!shared&&!read(localStorage,seenKey))showWelcome();
}
