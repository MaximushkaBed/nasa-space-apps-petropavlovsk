import { scientificSignature } from './scientific-context.js';

const questions = {
  anomaly: {title:'Отклонение от сезонной нормы',note:'Активность по месяцам, сезонная норма и отклонение от неё. Для сравнения используются те же дни других базовых лет.', tab:'calendar'},
  'compare-years': {title:'Сравнение активности по годам',note:'Недельные профили двух лет, пики активности и доступные периоды на исходном ряду одного спутника.', tab:'compare'},
  'sensor-transition': {title:'Сопоставимость спутниковых данных',note:'Ошибка сопоставления с Aqua, проверка на отложенных годах и допуск модели для выбранной территории.', tab:'validation'},
};
const fieldNames = {start:'Начало истории',end:'Конец истории',baseline_start:'Первый базовый год',baseline_end:'Последний базовый год',platform:'Спутник',quality:'Архив',grid_km:'Сетка, км',daynight:'Время суток',focus:'Фокус карты'};
const make = (tag, className, text) => {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const textValue = value => value==null?'не задано':value==='auto'?'автоматический выбор':value==='all'?'все':String(value);
const conditionText = (config, platform) => `${platform==='all'?'Все спутники':platform} · ${config.start} — ${config.end} · база ${config.baseline_start}–${config.baseline_end} · ${config.grid_km} км · ${config.quality==='all'?'SP + NRT':'SP'}${config.daynight==='D'?' · день':config.daynight==='N'?' · ночь':''}`;
const changeText = change => `${fieldNames[change.field]||change.field}: ${textValue(change.from)} → ${textValue(change.to)}.${change.reason?' '+change.reason:''}`;
const availabilityNames = {'published-world-calendar':'Обновляемый мировой архив FIRMS','seed-world-calendar':'Сохранённый снимок мирового архива FIRMS',unknown:'Сведения об архиве пока недоступны'};
const dataPurposes = {
  anomaly:'Покажем, когда спутник обнаруживал больше или меньше активности, чем обычно для этой территории и времени года.',
  'compare-years':'Покажем активность одного спутника за разные годы. Два года для сравнения можно выбрать в готовом результате.',
  'sensor-transition':'Проверим, насколько данные выбранного спутника согласуются с Aqua на этой территории. Допуск будет известен после расчёта.',
};

function dataSummary(config,platform,question){
  const list=make('dl','study-data-summary');
  const rows=[['Спутник',platform==='all'?'Пока не выбран':platform],['Период анализа',`${config.start} — ${config.end}`]];
  if(question==='anomaly')rows.push(['С чем сравниваем',`Те же календарные дни в ${config.baseline_start}–${config.baseline_end}`]);
  else if(question==='sensor-transition')rows.push(['Годы обучения',`${config.baseline_start}–${config.baseline_end}`]);
  for(const [label,value] of rows){const row=make('div');row.append(make('dt','',label),make('dd','',value));list.append(row);}
  return list;
}

// This controller retains only portable intent. Metadata options and assessment
// responses are always requested again; they are never restored as evidence.
export function mountStudyPlanner(root, {request,getInput,validate,applyOption,onQuestion,onChange,onPlanning,onExistingResult,openSettings,isActive}) {
  const $ = id => root.querySelector('#'+CSS.escape(id));
  let state={question:'anomaly',optionId:null,stage:'question',appliedSignature:null};
  let plan=null,planSignature=null,sequence=0,planAbort=null,assessmentAbort=null,resultRef=null,assessmentKey=null,loading=false,suspended=false,appliedChanges=[];
  $('study-options-home').append($('study-plan-display'));
  const signature = () => {const input=getInput();return scientificSignature(input.config)+'|'+input.platform+'|'+state.question;};
  const safeSignature = () => {try{return signature();}catch{return null;}};
  function focusChange(config){const focus=getInput().focus;if(!focus||!config||!(focus.start<config.start||focus.end>config.end))return null;return {field:'focus',from:`${focus.start} — ${focus.end}`,to:'месяц внутри выбранной истории',reason:'Выбранные условия не включают прежний фокус карты. История не будет расширена автоматически.'};}
  function cancelPlan(){++sequence;planAbort?.abort();planAbort=null;loading=false;}
  function cancelAssessment(){assessmentAbort?.abort();assessmentAbort=null;assessmentKey=null;}
  function changed(){onChange?.();}
  function render(){
    const {config,platform}=getInput();
    $('study-question').value=state.question;
    $('study-question-note').textContent=questions[state.question].note;
    $('study-current-conditions').replaceChildren(dataSummary(config,platform,state.question));
    $('study-plan-request').disabled=loading||state.stage==='running'||root.dataset.bootstrapPending==='true';
    $('study-plan-request').textContent=loading?'Проверяем доступные данные…':'Проверить доступные данные';
    $('study-plan-options').setAttribute('aria-busy',String(loading));
    const applied=Boolean(state.appliedSignature&&state.appliedSignature===safeSignature());
    $('study-applied').hidden=!applied;
    $('study-applied-title').textContent=state.optionId==='manual'?'Ваши настройки анализа':'Данные выбраны';
    $('study-applied-summary').replaceChildren(dataSummary(config,platform,state.question));
    $('study-applied-changes').replaceChildren(...appliedChanges.map(change=>make('li','',changeText(change))));
    $('study-applied-changes').hidden=!appliedChanges.length;
    const running=state.stage==='running';
    $('study-current-conditions').hidden=Boolean(plan||applied||running||state.stage==='result');
    root.querySelector('.submit-area').hidden=!(applied||running||state.stage==='result'||$('manual-conditions').open);
    $('study-applied').querySelector('.hint').textContent=running?'Считаем по этим данным.':state.stage==='result'?'Эти данные использованы в расчёте. Изменение параметров потребует нового расчёта.':'Всё готово к запуску. Нажмите «Построить анализ».';
    if(running)$('study-plan-status').textContent='Расчёт запущен по выбранным данным.';
    else if(state.stage==='result')$('study-plan-status').textContent='Данные использованы в расчёте. Возможность сравнения показана рядом с результатом.';
    $('study-next-title').textContent=running?'Рассчитываем активность территории':applied?'Можно строить анализ':plan?'Выберите данные для анализа':'Проверим данные для вашей задачи';
    const nextNote=running?'Прогресс показан над картой. Расчёт использует выбранную границу, историю, сетку и фильтры.':applied?'Спутник и годы указаны в панели «Параметры». Нажмите «Построить анализ», чтобы получить результат.':plan?'Предлагаемый вариант показывает спутник, доступный период и годы для сравнения. Изменения дат указаны до выбора.':null;
    $('study-next-note').replaceChildren(...(nextNote?[nextNote]:[dataPurposes[state.question],' ','Сначала проверим, какие данные есть в архиве.']));
    $('study-next-action').textContent=running?'К прогрессу расчёта ↑':applied?'К запуску расчёта ↑':plan?'Выбрать данные ↑':'Проверить данные ↑';
    $('study-next-action').hidden=false;
    $('study-existing-result').hidden=!resultRef||state.stage==='result'||running;
    root.dataset.studyStage=state.stage;
  }
  function invalidate(){
    cancelPlan();cancelAssessment();resultRef=null;plan=null;planSignature=null;
    state={...state,optionId:null,stage:'question',appliedSignature:null};appliedChanges=[];
    $('study-plan-options').replaceChildren();$('study-assessment').hidden=true;
    $('study-plan-status').textContent='Параметры изменились. Проверьте доступные данные заново или используйте дополнительные настройки.';
    render();
  }
  function renderPlan(){
    const content=document.createDocumentFragment();
    const options=plan.options||[];
    const primary=options.find(option=>option.id===plan.recommended_option_id&&option.status==='proposed')||options.find(option=>option.status==='proposed')||options[0];
    const alternatives=make('details','study-other-data');alternatives.append(make('summary','','Другие варианты данных'));
    for(const option of primary?[primary,...options.filter(option=>option!==primary)]:[]){
      const article=make('article','study-option');article.dataset.optionId=option.id;
      article.append(make('h3','',option.id==='current-request'?'Оставить мои настройки':option.platform||option.title));
      if(option.id===plan.recommended_option_id&&option.id!=='current-request'&&option.status==='proposed')article.append(make('span','study-option-label','Подходит по наличию архива'));
      article.append(make('p','study-option-description',option.id==='current-request'?'Сохраним указанные даты и настройки. Если данных для сравнения не хватит, покажем исходную активность и объясним ограничения.':dataPurposes[state.question]));
      if(option.config)article.append(dataSummary(option.config,option.platform,state.question));
      const changes=[...(option.changes||[]),focusChange(option.config)].filter(Boolean);
      if(changes.length){article.append(make('strong','study-data-changes-label','Что изменится при выборе'));const list=make('ul','study-option-changes');changes.forEach(change=>list.append(make('li','',changeText(change))));article.append(list);}
      else article.append(make('p','hint','Выбранные даты и настройки сохраняются.'));
      if(option.reason)article.append(make('p','study-option-reason',option.reason));
      const details=make('details','study-option-limitations');details.append(make('summary','','Параметры и ограничения'));
      if(option.description)details.append(make('p','',option.description));
      if(option.config)details.append(make('p','study-option-config',conditionText(option.config,option.platform)));
      if(option.limitations?.length){const list=make('ul');option.limitations.forEach(value=>list.append(make('li','',value)));details.append(list);}article.append(details);
      const button=make('button','outline full',option.status==='unavailable'?'Данных для сравнения не хватает':'Выбрать эти данные');button.type='button';button.dataset.studyApply=option.id;
      button.setAttribute('aria-label',`${option.status==='unavailable'?'Данных для сравнения не хватает':'Выбрать эти данные'}: ${option.title||option.platform}`);
      button.disabled=option.status!=='proposed'||!option.config||!option.platform||option.platform==='auto'||option.platform==='all';
      button.addEventListener('click',()=>choose(option));article.append(button);(option===primary?content:alternatives).append(article);
    }
    if(options.length>1)content.append(alternatives);
    const availability=plan.availability||{},details=make('details','study-plan-evidence');details.append(make('summary','','Источник и дата проверки'));
    details.append(make('p','',`${availabilityNames[availability.source]||availabilityNames.unknown}${availability.snapshot_at?' · снимок '+availability.snapshot_at:''}. Учитывается наличие глобального продукта. Локальная видимость неизвестна.`));
    if(plan.warnings?.length){const list=make('ul');plan.warnings.forEach(value=>list.append(make('li','',value)));details.append(list);}
    content.append(details);$('study-plan-options').replaceChildren(content);
  }
  async function requestPlan(){
    if(!validate())return;
    cancelPlan();plan=null;planSignature=null;
    onPlanning?.();$('study-assessment').hidden=true;
    const current=sequence,input=getInput(),intended=signature();
    planAbort=new AbortController();loading=true;state={...state,optionId:null,stage:'question',appliedSignature:null};appliedChanges=[];
    $('study-plan-options').replaceChildren();$('study-plan-status').textContent='Проверяем наличие данных в архиве. Территория и даты пока не меняются.';render();changed();
    try{
      const response=await request('/api/v1/study-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:state.question,platform:input.platform==='all'?'auto':input.platform,config:input.config}),signal:planAbort.signal});
      if(current!==sequence||suspended||!isActive()||safeSignature()!==intended)return;
      plan=response;planSignature=intended;state.stage='proposed';$('manual-conditions').open=false;renderPlan();
      const count=(plan.options||[]).filter(option=>option.status==='proposed'&&!['auto','all'].includes(option.platform)).length;
      $('study-plan-status').textContent=count?'Выберите данные ниже. Возможность сравнения для вашей территории проверим после расчёта.':'Данных для сравнения пока не хватает. Откройте ограничения или измените дополнительные настройки.';
      render();changed();
    }catch(error){if(current!==sequence||error.name==='AbortError'||suspended||!isActive())return;$('study-plan-status').textContent='Не удалось проверить данные: '+error.message+' Параметры сохранены; повторите проверку или откройте дополнительные настройки.';}
    finally{if(current===sequence){loading=false;planAbort=null;if(!suspended&&isActive())render();}}
  }
  function choose(option){
    if(!plan||planSignature!==safeSignature()||option.status!=='proposed'||['auto','all'].includes(option.platform))return;
    cancelAssessment();resultRef=null;
    const extraChange=focusChange(option.config);
    try{applyOption(option);}catch(error){$('study-plan-status').textContent=error.message;return;}
    appliedChanges=[...(option.changes||[]),extraChange].filter(Boolean);
    state={...state,optionId:option.id,stage:'applied',appliedSignature:signature()};
    $('manual-conditions').open=false;
    // The cards describe the old request. Keep the chosen explanation, not stale actions.
    plan=null;planSignature=null;$('study-plan-options').replaceChildren();
    $('study-plan-status').textContent='Данные выбраны. Нажмите «Построить анализ», чтобы запустить расчёт.';render();changed();
    $('study-applied').tabIndex=-1;$('study-applied').focus({preventScroll:true});$('run').scrollIntoView({block:'nearest'});
  }
  function prepareRun(){
    cancelPlan();cancelAssessment();resultRef=null;
    if(state.appliedSignature!==safeSignature()||!state.optionId){state.optionId='manual';appliedChanges=[];}
    state.appliedSignature=signature();state.stage='running';
    plan=null;planSignature=null;$('study-plan-options').replaceChildren();$('study-assessment').hidden=true;render();changed();
  }
  function runFailed(){if(state.stage==='running'){state.stage='applied';$('study-plan-status').textContent='Расчёт не завершён. Выбранные данные сохранены; можно повторить запуск.';render();changed();}}
  function resultReady(value,{navigate=false}={}){
    resultRef=value;state.stage='result';state.optionId=state.optionId||'manual';state.appliedSignature=safeSignature();
    $('study-assessment').hidden=false;render();if(navigate)onQuestion?.(questions[state.question].tab,{result:true});changed();assess();
  }
  function updateMonth(value){if(!resultRef)return;resultRef={...resultRef,...value};assess();}
  async function assess(force=false){
    if(!resultRef||suspended||!isActive())return;
    const {id,platform,month}=resultRef,intended=safeSignature();if(!intended||!id)return;
    const key=[id,intended,state.question==='anomaly'?month:''].join('|');if(key===assessmentKey&&!force)return;
    cancelAssessment();assessmentKey=key;const controller=new AbortController();assessmentAbort=controller;
    $('study-assessment').hidden=false;$('study-assessment').dataset.status='loading';$('study-assessment-badge').textContent='Проверка';$('study-assessment-title').textContent='Проверяем пригодность сравнения';$('study-assessment-summary').textContent='По рассчитанным данным выбранной территории, платформы и периода.';$('study-assessment-details').hidden=true;$('study-assessment-retry').hidden=true;
    const query=new URLSearchParams({question:state.question,platform});if(state.question==='anomaly'&&month)query.set('month',month);
    try{
      const response=await request(`/api/v1/analyses/${encodeURIComponent(id)}/study-assessment?${query}`,{signal:controller.signal});
      if(controller.signal.aborted||assessmentKey!==key||intended!==safeSignature()||suspended||!isActive())return;
      const status=['ready','limited','unavailable'].includes(response.status)?response.status:'unavailable';
      $('study-assessment').dataset.status=status;$('study-assessment-badge').textContent={ready:'Доступно',limited:'С ограничениями',unavailable:'Недостаточно данных'}[status];
      $('study-assessment-title').textContent=response.title||'Результат проверки';$('study-assessment-summary').textContent=response.summary||(response.reasons||[])[0]||'Откройте основания и ограничения результата.';
      $('study-assessment-reasons').replaceChildren(...[...new Set([...(response.reasons||[]),...(response.limitations||[])])].map(value=>make('li','',value)));
      const facts=response.facts||{},parts=[];
      const count=value=>Array.isArray(value)?value.length:Number.isFinite(value)?value:null;
      if(count(facts.comparable_months)!==null)parts.push(`Сопоставимых месяцев: ${count(facts.comparable_months)} из ${count(facts.target_months)??'—'}`);
      if(state.question==='anomaly'&&month)parts.push(`Выбранный месяц: ${month}`);
      if(facts.baseline_year_ids?.length)parts.push(`Базовые годы: ${facts.baseline_year_ids.join(', ')}`);
      if(typeof facts.model_accepted==='boolean')parts.push(`Согласование с Aqua: ${facts.model_accepted?'допущено для проверенных условий':'не допущено'}`);
      if(Number.isFinite(facts.fit_months)||Number.isFinite(facts.test_months))parts.push(`Обучение / проверка: ${facts.fit_months??'—'} / ${facts.test_months??'—'} месяцев`);
      if(facts.snapshot_at)parts.push(`Снимок: ${facts.snapshot_at}`);
      $('study-assessment-facts').textContent=parts.join(' · ');$('study-assessment-details').hidden=false;
    }catch(error){if(controller.signal.aborted||assessmentKey!==key||suspended||!isActive())return;$('study-assessment').dataset.status='error';$('study-assessment-badge').textContent='Проверка недоступна';$('study-assessment-title').textContent='Расчёт готов, допуск не подтверждён';$('study-assessment-summary').textContent=error.message+' Можно изучить исходные ряды и повторить проверку.';$('study-assessment-retry').hidden=false;}
    finally{if(assessmentAbort===controller)assessmentAbort=null;}
  }
  function restore(saved){
    cancelPlan();cancelAssessment();plan=null;resultRef=null;appliedChanges=[];$('study-plan-options').replaceChildren();$('study-assessment').hidden=true;
    const question=questions[saved?.question]?saved.question:'anomaly';
    state={question,optionId:saved?.optionId||null,stage:'question',appliedSignature:saved?.appliedSignature||null};
    if(state.appliedSignature===safeSignature()&&state.optionId)state.stage='applied';
    else{state.optionId=null;state.appliedSignature=null;}
    $('study-plan-status').textContent=state.stage==='applied'?'Выбранные данные восстановлены. Возможность сравнения проверим после расчёта.':saved?.stage==='proposed'?'Задача и параметры восстановлены. Проверьте доступные данные заново.':'Проверьте доступные данные или откройте дополнительные настройки.';render();
  }
  $('study-question').addEventListener('change',()=>{state.question=$('study-question').value;invalidate();onQuestion?.(null,{invalidate:true});changed();});
  $('study-plan-request').addEventListener('click',requestPlan);
  $('study-existing-result').addEventListener('click',()=>{cancelPlan();plan=null;planSignature=null;$('study-plan-options').replaceChildren();onExistingResult?.();});
  $('manual-conditions').addEventListener('toggle',render);
  $('study-assessment-retry').addEventListener('click',()=>assess(true));
  $('study-change-conditions').addEventListener('click',()=>{openSettings?.('task');$('study-question').scrollIntoView({block:'center'});$('study-question').focus({preventScroll:true});});
  $('study-next-action').addEventListener('click',()=>{const id=state.stage==='running'?'job-banner':state.stage==='applied'?'run':'study-plan-request';if(id!=='job-banner')openSettings?.('conditions');$(id).scrollIntoView({block:'center'});if(id!=='job-banner')$(id).focus({preventScroll:true});});
  render();
  return {invalidate,prepareRun,runFailed,resultReady,updateMonth,restore,getState:()=>({...state}),pause(){suspended=true;cancelPlan();cancelAssessment();if(state.stage==='running')state.stage='applied';},resume(){suspended=false;render();if(resultRef)assess();}};
}
