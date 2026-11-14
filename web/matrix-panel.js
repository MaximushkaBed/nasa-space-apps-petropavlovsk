import { sameScientificConfig } from './scientific-context.js';

const svgNS='http://www.w3.org/2000/svg';
const modeLabels={within:'По дням · внутри месяцев',pooled:'По дням · весь период',space:'По участкам'};
const format=new Intl.NumberFormat('ru',{maximumFractionDigits:3});
const finite=Number.isFinite;
const text=value=>value===null||value===undefined?'—':typeof value==='number'?format.format(value):String(value);
const element=(tag,attrs={},content)=>{const node=document.createElement(tag);Object.entries(attrs).forEach(([name,value])=>node.setAttribute(name,value));if(content!==undefined)node.textContent=content;return node;};
const svg=(tag,attrs={},content)=>{const node=document.createElementNS(svgNS,tag);Object.entries(attrs).forEach(([name,value])=>node.setAttribute(name,value));if(content!==undefined)node.textContent=content;return node;};

export function mountMatrixPanel(root,{request,getAnalysis,bridge={}}){
 root.classList.add('matrix-tool');
 root.innerHTML=`<div class="matrix-intro"><h4>Связи факторов выбранной территории</h4><p>Корреляция Спирмена показывает совместное изменение величин и не доказывает причину горения.</p></div>
 <p class="matrix-scope"></p><button class="primary matrix-run" type="button">Рассчитать матрицу</button>
 <p class="matrix-status" role="status">Сначала постройте временной анализ. Матрица рассчитывается отдельным запросом.</p><progress class="matrix-progress" max="100" value="0" hidden aria-label="Прогресс расчёта матрицы"></progress>
 <div class="matrix-controls" hidden><label>Метод<select class="matrix-mode"><option value="within">По дням · внутри месяцев</option><option value="pooled">По дням · весь период</option><option value="space">По участкам</option></select></label><label>Спутник<select class="matrix-platform"></select></label></div>
 <div class="matrix-warnings" hidden></div><div class="matrix-grid"></div><p class="matrix-definition" hidden></p>
 <section class="matrix-pair" hidden><h4 class="matrix-pair-title"></h4><p class="matrix-pair-summary"></p><div class="matrix-scatter"></div><p class="matrix-pair-note"></p><button class="outline matrix-on-map" type="button" hidden>Показать участки в атласе</button></section>
 <div class="matrix-exports" hidden><button class="outline matrix-export-csv" type="button">Матрица CSV ↓</button><button class="outline matrix-export-json" type="button">Данные JSON ↓</button><button class="outline matrix-export-image" type="button">График SVG ↓</button></div>
 <details class="matrix-provenance" hidden><summary>Источники и параметры матрицы</summary><pre></pre></details>`;
 const $=selector=>root.querySelector(selector);
 let id=null,result=null,busy=false,paused=false,visible=false,epoch=0,pollEpoch=0,mode='within',platform=null,pair=[0,1],analysisId=null,lastSource=null,hasError=false,restorePlatform=null;
 function status(message,error=false){hasError=error;$('.matrix-status').textContent=message;$('.matrix-status').classList.toggle('is-error',error);}
 function fields(){return mode==='space'?result?.space_factors||[]:result?.time_factors||[];}
 function cellAt(i,j){const value=result?.results?.[platform]?.[mode]?.[i]?.[j];return Array.isArray(value)?{rho:value[0],n:value[1]}:value&&typeof value==='object'?value:{rho:null,n:null};}
 function detailAt(i,j){return result?.pair_details?.[platform]?.[mode]?.[i]?.[j]||{};}
 function roiName(config){const names={sko:'Северо-Казахстанская область',california:'Калифорния · окно',brazil:'Мату-Гросу · окно',canada:'Альберта · окно'};return config?.roi_name||names[config?.preset]||(Array.isArray(config?.bbox)?`Область ${config.bbox.map(value=>text(value)).join(', ')}`:'Выбранная область');}
 function refresh(){
  const analysis=getAnalysis();
  const config=result?.config||analysis?.result?.config;
  $('.matrix-scope').textContent=config?`${roiName(config)} · ${config.start} — ${config.end} · сетка ${config.grid_km} км · исходные величины · ${config.quality==='all'?'SP + предварительные NRT':'SP'} · локальная видимость неизвестна`:'Матрица относится к территории и истории текущего анализа.';
  $('.matrix-run').disabled=busy||!analysis||analysis.platform==='all';
  $('.matrix-run').textContent=busy?'Матрица рассчитывается…':result?'Рассчитать заново':'Рассчитать матрицу';
  $('.matrix-progress').hidden=!busy;
  if(!busy&&!result&&analysis&&!hasError)status('Нажмите «Рассчитать матрицу», чтобы получить факторы для этой территории.');
  if(analysis?.platform!==lastSource){lastSource=analysis?.platform;if(result&&result.platforms?.includes(lastSource)){platform=lastSource;$('.matrix-platform').value=platform;if(visible)render();}}
 }
 async function start(){
  const analysis=getAnalysis();if(!analysis||analysis.platform==='all'){status('Для матрицы нужен готовый анализ и выбранный спутник.',true);return;}
  const token=++epoch;analysisId=analysis.id;result=null;id=null;busy=true;hideResults();refresh();status('Создаю запрос факторов для выбранной территории…');$('.matrix-progress').value=0;
  try{
   const job=await request(`/api/v1/analyses/${encodeURIComponent(analysisId)}/matrix`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   if(token!==epoch)return;id=job.id;if(!id)throw new Error('Сервис не вернул идентификатор матрицы.');
   if(!paused)await poll(token);
  }catch(error){if(token===epoch){busy=false;status(error.message,true);refresh();}}
 }
 async function poll(token=epoch){
  const polling=++pollEpoch;
  try{
   while(token===epoch&&polling===pollEpoch&&!paused&&id){
    const job=await request(`/api/v1/matrices/${encodeURIComponent(id)}`);
    if(token!==epoch||polling!==pollEpoch||paused)return;
    status(job.message||'Матрица рассчитывается…');$('.matrix-progress').value=job.progress||0;
    if(job.status==='error'||job.status==='failed')throw new Error(job.message||'Не удалось рассчитать матрицу.');
    if(job.status==='done'){
     if(!job.result)throw new Error('Сервис вернул матрицу без результатов.');
     if(job.result.analysis_id&&job.result.analysis_id!==analysisId)throw new Error('Сохранённая матрица относится к другому расчёту. Рассчитайте матрицу этой территории.');
     const current=getAnalysis();
     if(!current||current.id!==analysisId||!sameScientificConfig(job.result.config,current.result.config)||job.result.extract_id!==current.result.extract_id||job.result.snapshot_at!==current.result.snapshot_at)throw new Error('Параметры сохранённой матрицы не совпадают с территорией, историей или снимком текущего анализа. Рассчитайте матрицу выбранной территории.');
     result=job.result;busy=false;const preferred=restorePlatform||getAnalysis()?.platform;restorePlatform=null;platform=result.platforms?.includes(preferred)?preferred:result.platforms?.[0]||null;
     $('.matrix-platform').replaceChildren(...(result.platforms||[]).map(name=>new Option(name,name)));$('.matrix-platform').value=platform||'';
     status('Матрица готова. Выберите пару, чтобы увидеть реальные наблюдения.');showResults();refresh();render();return;
    }
    await new Promise(resolve=>setTimeout(resolve,1200));
   }
  }catch(error){if(token===epoch&&polling===pollEpoch){busy=false;status(error.message,true);refresh();}}
 }
 function hideResults(){for(const selector of ['.matrix-controls','.matrix-warnings','.matrix-definition','.matrix-pair','.matrix-exports','.matrix-provenance'])$(selector).hidden=true;$('.matrix-grid').replaceChildren();}
 function showResults(){
  for(const selector of ['.matrix-controls','.matrix-definition','.matrix-exports','.matrix-provenance'])$(selector).hidden=false;
  const warnings=result.warnings||[];$('.matrix-warnings').replaceChildren();$('.matrix-warnings').hidden=!warnings.length;
  for(const warning of warnings){const p=element('p',{},typeof warning==='string'?warning:JSON.stringify(warning));$('.matrix-warnings').append(p);}
  $('.matrix-provenance pre').textContent=JSON.stringify({analysis_id:analysisId,matrix_id:id,config:result.config,snapshot_at:result.snapshot_at,through:result.through,version:result.version,provenance:result.provenance,warnings:result.warnings},null,2);
 }
 function reasonLabel(detail,cell){
  const names={insufficient_pairs:'Недостаточно пар',insufficient_pairs_or_strata:'Недостаточно пар или пригодных временных групп',insufficient_data:'Недостаточно данных',insufficient_overlap:'Недостаточно общих наблюдений',constant:'Постоянная величина',constant_input:'Постоянная величина',no_variation:'Нет вариации',unavailable:'Фактор недоступен',no_data:'Нет данных'};
  return detail.reason?(names[detail.reason]||'Оценка недоступна'):finite(cell.rho)?'':`Корреляция не оценена${finite(cell.n)?` · общих наблюдений ${cell.n}`:''}`;
 }
 function pairCounts(detail,cell){return {overlap:detail.n_overlap??cell.n,used:detail.n_used??(finite(cell.rho)?cell.n:null)};}
 function render(){
  if(!result)return;
  const factors=fields(),table=element('table'),caption=element('caption',{},`${modeLabels[mode]} · ${platform||'спутник не выбран'} · ρ Спирмена и число пар`);table.append(caption);
  const head=element('tr');head.append(element('th',{scope:'col'},'Фактор'));factors.forEach(f=>head.append(element('th',{scope:'col',title:`${f.label}${f.unit?` · ${f.unit}`:''}`},f.short||f.label)));
  const thead=element('thead');thead.append(head);table.append(thead);const tbody=element('tbody');
  factors.forEach((factor,i)=>{
   const row=element('tr');row.append(element('th',{scope:'row',title:factor.unit||''},factor.short||factor.label));
   factors.forEach((other,j)=>{
    const cell=cellAt(i,j),detail=detailAt(i,j),counts=pairCounts(detail,cell),countLabel=finite(cell.rho)?`n ${text(counts.used)}`:`общ. ${text(counts.overlap)}`,countDescription=`общих пар ${text(counts.overlap)}, использовано ${text(counts.used)}`,td=element('td'),button=element('button',{type:'button','data-pair':`${i},${j}`,'aria-label':`${factor.label} и ${other.label}: ${finite(cell.rho)?`ρ ${text(cell.rho)}`:reasonLabel(detail,cell)}; ${countDescription}`});
    button.className='matrix-cell'+(pair[0]===i&&pair[1]===j?' selected':'')+(finite(cell.rho)?'':' missing');
    if(finite(cell.rho)){const strength=Math.min(1,Math.abs(cell.rho));button.style.background=`hsl(${cell.rho>=0?24:211} 61% ${16+strength*23}%)`;}
    button.append(element('strong',{},finite(cell.rho)?text(cell.rho):'—'),element('small',{},countLabel));
    button.title=`${reasonLabel(detail,cell)||`${factor.label} / ${other.label} · ρ ${text(cell.rho)}`} · ${countDescription}`;
    button.addEventListener('click',()=>{pair=[i,j];render();});td.append(button);row.append(td);
   });tbody.append(row);
  });table.append(tbody);$('.matrix-grid').replaceChildren(table);
  $('.matrix-definition').textContent=(mode==='within'?'ρ объединяет связи внутри отдельных месяцев и лет. Сезонность и общий тренд могут отличаться от связи внутри месяцев.':mode==='pooled'?'ρ рассчитана по общим доступным датам всего периода. Общая сезонность может усиливать видимую связь.':'ρ сравнивает участки этой территории. Показатель горения — плотность исходных ячейко-дней; размер участка не равен выгоревшей площади.')+' n — пары, использованные для оценки ρ; «общ.» — доступные пары до отбора. Обе численности показаны в выбранной паре.';
  if(pair.some(index=>index>=factors.length))pair=[0,Math.min(1,factors.length-1)];
  renderPair();
 }
 function pairedValues(){
  const factors=fields(),[i,j]=pair;if(!factors[i]||!factors[j])return [];
  if(mode==='space')return (result.space_units||[]).flatMap(unit=>{
   const value=index=>index===0?unit.fire?.[platform]:unit.values?.[index-1];const x=value(i),y=value(j);
   return finite(x)&&finite(y)?[{x,y,label:String(unit.id),unit}]:[];
  });
  const series=result.time_series||{};
  return (series.dates||[]).flatMap((date,index)=>{
   const value=factor=>factor===0?series.fire?.[platform]?.[index]:series.conditions?.[index]?.[factor-1];const x=value(i),y=value(j);
   return finite(x)&&finite(y)?[{x,y,label:date}]:[];
  });
 }
 function renderPair(){
  const factors=fields(),[i,j]=pair;if(!factors[i]||!factors[j]){$('.matrix-pair').hidden=true;return;}
  $('.matrix-pair').hidden=false;const cell=cellAt(i,j),detail=detailAt(i,j),points=pairedValues();
  $('.matrix-pair-title').textContent=`${factors[i].label} × ${factors[j].label}`;
  const counts=pairCounts(detail,cell);
  $('.matrix-pair-summary').textContent=`${platform} · ${modeLabels[mode]} · ${finite(cell.rho)?`ρ ${text(cell.rho)}`:reasonLabel(detail,cell)} · общих пар ${text(counts.overlap)} · использовано ${text(counts.used)} · пар на рисунке ${points.length}`;
  $('.matrix-pair-note').textContent=mode==='within'?'На рисунке — исходные пары по датам, а ρ выше объединяет внутримесячные связи. Число нарисованных пар может отличаться от n использованных в оценке. Пропуски исключены попарно; они не заменяются нулями.':`Точки показывают реальные ${mode==='space'?'участки':'даты'} с обеими доступными величинами. Пропуски исключены попарно; они не заменяются нулями. Корреляция не устанавливает причину горения.`;
  $('.matrix-on-map').hidden=mode!=='space'||!points.length||bridge.matrixMapAvailable!==true;
  drawScatter(points,factors[i],factors[j]);
 }
 function drawScatter(points,xFactor,yFactor){
  const host=$('.matrix-scatter');host.replaceChildren();
  if(!points.length){host.append(element('p',{class:'matrix-empty'},'Нет общих числовых наблюдений для выбранной пары.'));return;}
  const width=Math.max(300,host.clientWidth),height=265,left=58,right=16,top=20,bottom=53;
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y),xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  const x=v=>left+(v-xmin)/(xmax-xmin||1)*(width-left-right),y=v=>height-bottom-(v-ymin)/(ymax-ymin||1)*(height-top-bottom);
  const plot=svg('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':`${xFactor.label} и ${yFactor.label}: ${points.length} фактических пар`});
  for(let index=0;index<=3;index++){
   const xv=xmin+(xmax-xmin)*index/3,yv=ymin+(ymax-ymin)*index/3;
   plot.append(svg('line',{x1:left,x2:width-right,y1:y(yv),y2:y(yv),stroke:'#2a4072'}),svg('text',{x:left-7,y:y(yv)+4,'text-anchor':'end'},text(yv)),svg('text',{x:x(xv),y:height-bottom+18,'text-anchor':'middle'},text(xv)));
  }
  for(const point of points){const dot=svg('circle',{cx:x(point.x),cy:y(point.y),r:2.8,fill:'#ffa46e','fill-opacity':.7});dot.append(svg('title',{},`${point.label} · ${xFactor.label}: ${text(point.x)}; ${yFactor.label}: ${text(point.y)}`));plot.append(dot);}
  plot.append(svg('text',{x:(left+width-right)/2,y:height-5,'text-anchor':'middle'},`${xFactor.short||xFactor.label}${xFactor.unit?` (${xFactor.unit})`:''}`),svg('text',{x:left,y:12},`${yFactor.short||yFactor.label}${yFactor.unit?` (${yFactor.unit})`:''}`));host.append(plot);
 }
 function save(blob,name){const url=URL.createObjectURL(blob),link=element('a',{href:url,download:name});root.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function exportData(type){
  if(!result){status('Сначала рассчитайте матрицу.',true);return;}
  if(type==='json'){save(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),`nasa-space-apps-matrix-${id}.json`);return;}
  const rows=[['matrix_id','analysis_id','platform','mode','factor_x','factor_y','rho','n','reason','n_overlap','n_used','strata_used','mask_sha256','roi','start','end','quality','snapshot_at']];
  for(const name of result.platforms||[])for(const method of ['within','pooled','space']){
   const fs=method==='space'?result.space_factors||[]:result.time_factors||[];
   fs.forEach((a,i)=>fs.forEach((b,j)=>{const c=result.results?.[name]?.[method]?.[i]?.[j],d=result.pair_details?.[name]?.[method]?.[i]?.[j]||{};const rho=Array.isArray(c)?c[0]:c?.rho,n=Array.isArray(c)?c[1]:c?.n;rows.push([id,analysisId,name,method,a.id,b.id,rho,n,d.reason,d.n_overlap,d.n_used,d.strata_used,d.mask_sha256,roiName(result.config),result.config?.start,result.config?.end,result.config?.quality,result.snapshot_at]);}));
  }
  const csv=rows.map(row=>row.map(value=>`"${String(value??'').replaceAll('"','""')}"`).join(',')).join('\r\n');save(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),`nasa-space-apps-matrix-${id}.csv`);
 }
 function exportImage(){
  const plot=$('.matrix-scatter svg');if(!result||!plot){status('Выберите пару с числовыми наблюдениями для изображения.',true);return;}
  const width=1120,height=490,doc=svg('svg',{xmlns:svgNS,width,height,viewBox:`0 0 ${width} ${height}`});
  doc.append(svg('rect',{width:'100%',height:'100%',fill:'#07132d'}),svg('style',{},'text{font-family:Arial,sans-serif;fill:#f5f8ff;font-size:12px}'),svg('text',{x:28,y:31,style:'font-size:19px;font-weight:700'},'NASA Space Apps · Связи факторов'),svg('text',{x:28,y:56},$('.matrix-scope').textContent),svg('text',{x:28,y:80},$('.matrix-pair-title').textContent),svg('text',{x:28,y:102},$('.matrix-pair-summary').textContent));
  const copy=plot.cloneNode(true);copy.setAttribute('x',24);copy.setAttribute('y',118);copy.setAttribute('width',width-48);copy.setAttribute('height',270);doc.append(copy,svg('text',{x:28,y:414},`Снимок архива ${result.snapshot_at||'не указан'} · матрица ${id}`),svg('text',{x:28,y:437},'Показаны исходные парные наблюдения. Пропуски не заменены нулями. Локальная видимость неизвестна.'),svg('text',{x:28,y:460},'Корреляция не доказывает причину. Для режима внутри месяцев итоговая ρ объединяет отдельные внутримесячные связи.'));
  save(new Blob([new XMLSerializer().serializeToString(doc)],{type:'image/svg+xml;charset=utf-8'}),`nasa-space-apps-matrix-${platform}-${mode}.svg`);
 }
 function reset(){++epoch;++pollEpoch;id=result=analysisId=null;busy=false;pair=[0,1];lastSource=null;hideResults();status('Матрица рассчитывается отдельно по данным календаря.');refresh();}
 function pause(){paused=true;++pollEpoch;}
 function resume(){paused=false;if(busy&&id&&!result)poll();}
 async function restore(matrixId,state={}){const analysis=getAnalysis();if(!analysis)return;reset();analysisId=analysis.id;id=String(matrixId);busy=true;restorePlatform=state?.platform||null;if(state&&['within','pooled','space'].includes(state.mode)){mode=state.mode;$('.matrix-mode').value=mode;}if(Array.isArray(state?.pair)&&state.pair.length===2&&state.pair.every(index=>Number.isInteger(index)&&index>=0))pair=[...state.pair];refresh();status('Восстанавливаю сохранённую матрицу…');if(!paused)await poll();}
 $('.matrix-run').addEventListener('click',start);
 $('.matrix-mode').addEventListener('change',()=>{mode=$('.matrix-mode').value;render();});
 $('.matrix-platform').addEventListener('change',()=>{platform=$('.matrix-platform').value;render();});
 $('.matrix-export-csv').addEventListener('click',()=>exportData('csv'));$('.matrix-export-json').addEventListener('click',()=>exportData('json'));$('.matrix-export-image').addEventListener('click',exportImage);
 $('.matrix-on-map').addEventListener('click',()=>{const factors=fields();bridge.navigate?.('atlas',{context:getAnalysis()?.context,from:'matrix',matrixPair:{matrixId:id,platform,mode,factor_x:factors[pair[0]]?.id,factor_y:factors[pair[1]]?.id,unitIds:pairedValues().map(point=>point.unit.id)}});});
 refresh();return {refresh,reset,pause,resume,restore,setVisible(value){visible=value;if(visible&&result)render();},getState:()=>({id,result,busy,platform,mode,pair:[...pair]}),exportData,exportImage};
}
