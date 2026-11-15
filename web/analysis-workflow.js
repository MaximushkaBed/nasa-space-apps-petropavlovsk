import {localizeTree} from './i18n.js';
const steps=['territory','task','conditions','result'];
const titles={territory:'Территория',task:'Задача и период',conditions:'Данные для анализа',result:'Результат'};

export function mountAnalysisWorkflow(root,{getState,isActive,onLayout,onChange}){
 const $=id=>root.querySelector('#'+CSS.escape(id));
 let step='territory',open=true,wasDrawing=false;
 const panel=$('analysis-settings'),scroll=$('analysis-settings-scroll');
 function refresh(){
  const state=getState(),hasROI=Boolean(state.roi);
  if(!hasROI)step='territory';
  if(step==='result'&&!state.result&&!state.busy)step='conditions';
  root.dataset.workflowStep=step;root.dataset.settingsOpen=String(open);panel.hidden=!open;panel.inert=!open;
  $('analysis-settings-backdrop').hidden=!open;$('analysis-settings-toggle').setAttribute('aria-expanded',String(open));
  root.querySelectorAll('[data-workflow-step]').forEach(group=>group.hidden=group.dataset.workflowStep!==step);
  $('analysis-workflow-step').replaceChildren(`Шаг ${steps.indexOf(step)+1} из 4`,' · ',titles[step]);
  $('analysis-workflow-back').disabled=steps.indexOf(step)===0||state.busy;
  const ready=hasROI&&!state.busy&&!state.drawing;
  $('analysis-workflow-next').disabled=!ready||(step==='conditions'&&!state.result);
  $('analysis-workflow-next').hidden=step==='conditions'&&!state.result;
  $('analysis-workflow-next').textContent=step==='conditions'?'К результату':step==='result'?'Открыть результат':'Далее';
  $('analysis-workflow-message').textContent=state.loading?'Подключаем сведения об архиве…':!hasROI?'Найдите территорию или выделите участок на карте.':step==='conditions'&&!state.result?'Проверьте доступные данные или откройте дополнительные настройки.':'';
  $('analysis-workflow-summary').replaceChildren(...(hasROI?[state.roi.name,' · ',state.start+' — '+state.end,' · ',state.platform]:['Территория пока не выбрана']));
  localizeTree(panel);localizeTree($('analysis-settings-bar'));
 }
 function change(next=step,{show=true,focus=false}={}){
  const state=getState();if(!steps.includes(next))next='territory';if(next!=='territory'&&!state.roi)next='territory';
  step=next;open=show;refresh();scroll.scrollTop=0;onLayout?.();onChange?.();
  if(focus&&open){if(matchMedia('(pointer:coarse)').matches){panel.tabIndex=-1;panel.focus({preventScroll:true});}else{const target=step==='territory'?$('analysis-territory-query'):step==='task'?$('study-question'):step==='conditions'?$('study-plan-request'):$('analysis-workflow-show-result');target?.focus({preventScroll:true});}}
 }
 function close({focus=false}={}){open=false;refresh();onLayout?.();onChange?.();if(focus)$('analysis-settings-toggle').focus({preventScroll:true});}
 function showResult(){close();$('study-assessment').scrollIntoView({block:'start'});}
 $('analysis-settings-toggle').addEventListener('click',()=>open?close({focus:true}):change(step,{focus:true}));
 $('analysis-settings-close').addEventListener('click',()=>close({focus:true}));$('analysis-settings-backdrop').addEventListener('click',()=>close({focus:true}));
 $('analysis-workflow-back').addEventListener('click',()=>change(steps[Math.max(0,steps.indexOf(step)-1)],{focus:true}));
 $('analysis-workflow-next').addEventListener('click',()=>{
  if(step==='task'){const start=$('start'),end=$('end');start.setCustomValidity('');end.setCustomValidity('');if(!start.checkValidity()||!end.checkValidity()||start.value>end.value){$('analysis-workflow-message').textContent='Проверьте начало и конец периода истории.';(!start.validity.valid?start:end).focus();return;}}
  if(step==='result'||step==='conditions'){if(getState().result){step='result';showResult();}return;}
  change(steps[steps.indexOf(step)+1],{focus:true});
 });
 $('analysis-workflow-show-result').addEventListener('click',showResult);
 document.addEventListener('nasa:analysis-settings',event=>{if(!isActive())return;const detail=event.detail||{};if(detail.open===false)close();else change(detail.step||step,{focus:false});});
 root.addEventListener('keydown',event=>{if(!event.defaultPrevented&&event.key==='Escape'&&open&&!getState().drawing){event.preventDefault();close({focus:true});}});
 root.dataset.workflowReady='true';refresh();
 return {refresh,open:next=>change(next,{focus:true}),close,resume(){root.dataset.workflowActive='true';refresh();},pause(){root.dataset.workflowActive='false';},draw(active){if(active&&!wasDrawing){wasDrawing=true;close();}else if(!active&&wasDrawing){wasDrawing=false;change('territory',{focus:false});}},running(){step='result';close();},resultReady(){step='result';close();},getState:()=>({step,open}),restore(value){if(value&&steps.includes(value.step)){step=value.step;open=value.open!==false;}refresh();onLayout?.();}};
}
