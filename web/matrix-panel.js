import { localizeTree, numberFormat, protectLocaleText } from './i18n.js';
import { sameScientificConfig } from './scientific-context.js';

const svgNS='http://www.w3.org/2000/svg';
const modeLabels={within:'По дням · внутри месяцев',pooled:'По дням · весь период',space:'По участкам'};
const format=numberFormat({maximumFractionDigits:3});
const finite=Number.isFinite;
const text=value=>value===null||value===undefined?'—':typeof value==='number'?format.format(value):String(value);
const safeCell=value=>/^[\r\n\t ]*[=+@-]/.test(value)?`'${value}`:value;
const element=(tag,attrs={},content)=>{const node=document.createElement(tag);Object.entries(attrs).forEach(([name,value])=>node.setAttribute(name,value));if(content!==undefined)node.textContent=content;return node;};
const svg=(tag,attrs={},content)=>{const node=document.createElementNS(svgNS,tag);Object.entries(attrs).forEach(([name,value])=>node.setAttribute(name,value));if(content!==undefined)node.textContent=content;return node;};
const protectFactors=(node,...factors)=>protectLocaleText(node,factors
 .filter(factor=>factor.id.startsWith('file_'))
 .flatMap(factor=>[factor.label,factor.short].filter(Boolean)));

function scatterAxis(points,key,intervals){
 let min=Infinity,max=-Infinity;
 for(const point of points){min=Math.min(min,point[key]);max=Math.max(max,point[key]);}
 const largest=Math.max(Math.abs(min),Math.abs(max));
 const scale=largest>1e150||(largest>0&&largest<1e-150)?largest:1;
 min/=scale;max/=scale;
 if(min===max){const padding=Math.abs(min)*.05||1;min-=padding;max+=padding;}
 const target=Math.max((max-min)/intervals,Number.EPSILON*Math.max(Math.abs(min),Math.abs(max)));
 const exponent=Math.floor(Math.log10(target));
 const unit=10**exponent;
 const multiple=[1,2,2.5,5,10].find(value=>value*unit>=target)||10;
 const step=unit*multiple;
 const first=Math.floor(min/step),last=Math.ceil(max/step);
 const decimals=Math.max(0,-exponent+(multiple===2.5?1:0));
 const precision=Math.max(3,1+Math.floor(Math.log10(largest/scale))-exponent);
 const formatter=largest>=1e9||decimals>8||scale!==1
  ?numberFormat({notation:'scientific',maximumSignificantDigits:Math.min(17,precision)})
  :numberFormat({maximumFractionDigits:decimals});
 const ticks=[];
 for(let index=first;index<=last;index++){
  const value=index*step*scale;
  if(finite(value))ticks.push({fraction:(index-first)/(last-first),label:formatter.format(value)});
 }
 return {ticks,fraction:value=>(value/scale/step-first)/(last-first)};
}

function scatterPlot({points,xFactor,yFactor},width,height){
 const xAxis=scatterAxis(points,'x',6),yAxis=scatterAxis(points,'y',5);
 const left=Math.max(41,xAxis.ticks[0].label.length*3.5+8,Math.max(...yAxis.ticks.map(({label})=>label.length))*7+11);
 const right=width-Math.max(18,xAxis.ticks.at(-1).label.length*3.5+8);
 const top=27,bottom=height-44;
 const x=fraction=>left+fraction*(right-left),y=fraction=>bottom-fraction*(bottom-top);
 const plot=protectFactors(svg('svg',{width,height,viewBox:`0 0 ${width} ${height}`,role:'img',
  'aria-label':`${xFactor.label} и ${yFactor.label}: ${points.length} фактических пар`}),xFactor,yFactor);
 for(const {fraction,label} of yAxis.ticks){
  const row=y(fraction);
  plot.append(svg('line',{x1:left,x2:right,y1:row,y2:row,stroke:'#2a4072'}),
   svg('text',{x:left-8,y:row+4,'text-anchor':'end'},label));
 }
 const tickSpacing=Math.max(65,Math.max(...xAxis.ticks.map(({label})=>label.length))*7+10);
 const tickStride=Math.max(1,Math.ceil((xAxis.ticks.length-1)*tickSpacing/(right-left)));
 xAxis.ticks.forEach(({fraction,label},index)=>{
  if((xAxis.ticks.length-1-index)%tickStride===0)plot.append(svg('text',{x:x(fraction),y:bottom+16,'text-anchor':'middle'},label));
 });
 const radius=points.length>400?1.8:points.length>100?2.3:2.8;
 for(const point of points){
  const dot=svg('circle',{cx:x(xAxis.fraction(point.x)),cy:y(yAxis.fraction(point.y)),r:radius,fill:'#ffa46e','fill-opacity':points.length>400?.52:.72});
  dot.append(protectFactors(svg('title',{},`${point.label} · ${xFactor.label}: ${text(point.x)}; ${yFactor.label}: ${text(point.y)}`),xFactor,yFactor));
  plot.append(dot);
 }
 const title=factor=>`${factor.short||factor.label}${factor.unit?` (${factor.unit})`:''}`;
 plot.append(protectFactors(svg('text',{x:(left+right)/2,y:height-8,'text-anchor':'middle'},title(xFactor)),xFactor),
  protectFactors(svg('text',{x:left,y:14},title(yFactor)),yFactor));
 return plot;
}

export function mountMatrixPanel(root,{request,getAnalysis,bridge={},automatic=false,local=false,onDataChange}){
 root.classList.add('matrix-tool');
 root.innerHTML=`<div class="matrix-intro"><h4>Связи факторов выбранной территории</h4><p>Корреляция Спирмена показывает совместное изменение величин и не доказывает причину горения.</p></div>
 <p class="matrix-scope"></p><button class="primary matrix-run" type="button" ${automatic||local?'hidden':''}>Рассчитать матрицу</button>
 <p class="matrix-status" role="status">Сначала постройте временной анализ. Матрица рассчитывается отдельным запросом.</p><progress class="matrix-progress" max="100" value="0" hidden aria-label="Прогресс расчёта матрицы"></progress>
 <div class="matrix-controls" hidden><label>Метод<select class="matrix-mode"><option value="within">По дням · внутри месяцев</option><option value="pooled">По дням · весь период</option><option value="space">По участкам</option></select></label><label>Спутник<select class="matrix-platform"></select></label></div>
 <div class="matrix-grid" role="region" tabindex="0" aria-label="Матрица ранговых корреляций"></div><p class="matrix-scroll-hint" hidden>Прокрутите матрицу вправо, чтобы увидеть остальные показатели →</p><p class="matrix-definition" hidden></p>
 <section class="matrix-pair" hidden><h4 class="matrix-pair-title"></h4><p class="matrix-pair-summary" aria-live="polite"></p><div class="matrix-scatter"></div><p class="matrix-pair-note"></p><button class="outline matrix-on-map" type="button" hidden>Показать участки в атласе</button></section>
 <div class="matrix-exports" hidden><button class="outline matrix-export-csv" type="button">Матрица CSV ↓</button><button class="outline matrix-export-json" type="button">Данные JSON ↓</button><button class="outline matrix-export-image" type="button">График SVG ↓</button></div>
 <details class="matrix-warnings" hidden><summary>Ограничения данных и метода</summary><div></div></details>
 <details class="matrix-provenance" hidden><summary>Источники и параметры матрицы</summary><pre></pre></details>`;
 const $=selector=>root.querySelector(selector);
 const scatterHost=$('.matrix-scatter');
 let scatter,scatterWidth=0;
 new ResizeObserver(layoutScatter).observe(scatterHost);
 if(local)for(const selector of ['.matrix-intro','.matrix-status'])$(selector).hidden=true;
 let id=null,result=null,busy=false,paused=false,visible=false,epoch=0,pollEpoch=0,mode='within',platform=null,pair=[0,1],analysisId=null,lastSource=null,hasError=false,restorePlatform=null,startPromise=null;
 const pendingRequests=new Map();
 function requestMatrix(analysis){
  if(!pendingRequests.has(analysis)){
   const pending=request(`/api/v1/analyses/${encodeURIComponent(analysis)}/matrix`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   pendingRequests.set(analysis,pending);
   const clear=()=>{if(pendingRequests.get(analysis)===pending)pendingRequests.delete(analysis);};
   pending.then(clear,clear);
  }
  return pendingRequests.get(analysis);
 }
 function status(message,error=false){hasError=error;$('.matrix-status').textContent=message;$('.matrix-status').classList.toggle('is-error',error);}
 function fields(){return mode==='space'?result?.space_factors||[]:result?.time_factors||[];}
 function cellAt(i,j){const value=result?.results?.[platform]?.[mode]?.[i]?.[j];return Array.isArray(value)?{rho:value[0],n:value[1]}:value&&typeof value==='object'?value:{rho:null,n:null};}
 function detailAt(i,j){return result?.pair_details?.[platform]?.[mode]?.[i]?.[j]||{};}
 function roiName(config){const names={world:'Весь мир',sko:'Северо-Казахстанская область',california:'Калифорния · окно',brazil:'Мату-Гросу · окно',canada:'Альберта · окно'};return config?.roi_name||names[config?.preset]||(Array.isArray(config?.bbox)?`Область ${config.bbox.map(value=>text(value)).join(', ')}`:'Выбранная область');}
 function refresh(){
  if(local)return;
  const analysis=getAnalysis();
  const config=result?.config||analysis?.result?.config;
  $('.matrix-scope').textContent=config?`${analysis?.context?.roi?.name||roiName(config)} · ${config.start} — ${config.end} · сетка ${config.grid_km} км · исходные величины · ${config.quality==='all'?'SP + предварительные NRT':'SP'} · локальная видимость неизвестна`:'Матрица относится к территории и истории текущего анализа.';
  $('.matrix-run').disabled=busy||!analysis||analysis.platform==='all';
  $('.matrix-run').textContent=busy?'Матрица рассчитывается…':result?'Рассчитать заново':'Рассчитать матрицу';
  $('.matrix-progress').hidden=!busy;
  if(!automatic&&!busy&&!result&&analysis&&!hasError)status('Нажмите «Рассчитать матрицу», чтобы получить факторы для этой территории.');
  if(analysis?.platform!==lastSource){lastSource=analysis?.platform;if(result&&result.platforms?.includes(lastSource)){platform=lastSource;$('.matrix-platform').value=platform;if(visible)render();}}
  onDataChange?.({id,result,platform,analysisId,busy});
 }
 function matchesAnalysis(snapshot,analysis){return Boolean(snapshot&&analysis?.id===analysisId&&(!snapshot.analysis_id||snapshot.analysis_id===analysisId)&&sameScientificConfig(snapshot.config,analysis.result?.config)&&snapshot.extract_id===analysis.result?.extract_id&&snapshot.snapshot_at===analysis.result?.snapshot_at);}
 function start({refresh:force=false}={}){
  const analysis=getAnalysis();if(!analysis||analysis.platform==='all'){status('Для матрицы нужен готовый анализ и выбранный спутник.',true);return;}
  if(busy&&analysis.id===analysisId)return startPromise;
  // Opening another view reuses this immutable snapshot; an explicit rerun still
  // asks the server to check source versions and repair temporarily missing factors.
  if(!force&&matchesAnalysis(result,analysis)&&!result.warnings_sources?.length){refresh();if(visible)render();return;}
  const token=++epoch;analysisId=analysis.id;result=null;id=null;busy=true;hideResults();refresh();status('Проверяю готовую матрицу для выбранной территории…');$('.matrix-progress').value=0;
  const task=(async()=>{
   try{
    const job=await requestMatrix(analysisId);
    if(token!==epoch)return;id=job.id;if(!id)throw new Error('Сервис не вернул идентификатор матрицы.');
    if(job.status==='done'&&job.result){accept(job.result);return;}
    refresh();
    if(!paused)await poll(token);
   }catch(error){if(token===epoch){busy=false;status(error.message,true);refresh();}}
  })();
  startPromise=task;
  task.finally(()=>{if(startPromise===task)startPromise=null;});
  return task;
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
     accept(job.result);return;
    }
    await new Promise(resolve=>setTimeout(resolve,1200));
   }
  }catch(error){if(token===epoch&&polling===pollEpoch){busy=false;status(error.message,true);refresh();}}
 }
 function accept(snapshot){
  if(!snapshot)throw new Error('Сервис вернул матрицу без результатов.');
  if(snapshot.analysis_id&&snapshot.analysis_id!==analysisId)throw new Error('Матрица относится к другому расчёту.');
  const current=getAnalysis();
  if(!current||current.id!==analysisId||!sameScientificConfig(snapshot.config,current.result.config)||snapshot.extract_id!==current.result.extract_id||snapshot.snapshot_at!==current.result.snapshot_at)throw new Error('Параметры матрицы не совпадают с календарём.');
  result=snapshot;busy=false;const preferred=restorePlatform||current.platform;restorePlatform=null;platform=result.platforms?.includes(preferred)?preferred:result.platforms?.[0]||null;
  $('.matrix-platform').replaceChildren(...(result.platforms||[]).map(name=>new Option(name,name)));$('.matrix-platform').value=platform||'';
  status('Матрица готова. Выберите пару, чтобы увидеть реальные наблюдения.');showResults();refresh();if(visible)render();
 }
 function hideResults(){for(const selector of ['.matrix-controls','.matrix-warnings','.matrix-scroll-hint','.matrix-definition','.matrix-pair','.matrix-exports','.matrix-provenance'])$(selector).hidden=true;$('.matrix-grid').replaceChildren();scatter=null;scatterHost.replaceChildren();}
 function showResults(){
  for(const selector of ['.matrix-controls','.matrix-scroll-hint','.matrix-definition','.matrix-exports','.matrix-provenance'])$(selector).hidden=false;
  if(local) $('.matrix-controls').hidden=true;
  const warnings=result.warnings||[];const list=$('.matrix-warnings div');list.replaceChildren();$('.matrix-warnings').hidden=!warnings.length;
  for(const warning of warnings){const p=element('p',{},typeof warning==='string'?warning:JSON.stringify(warning));list.append(p);}
  const { labels, series, ...file } = result.imported || {};
  $('.matrix-provenance pre').textContent=JSON.stringify({analysis_id:analysisId,matrix_id:id,config:result.config,snapshot_at:result.snapshot_at,through:result.through,version:result.version,provenance:result.provenance,file:local?file:undefined,warnings:result.warnings},null,2);
 }
 function reasonLabel(detail,cell){
  const names={insufficient_pairs:'Недостаточно пар',insufficient_pairs_or_strata:'Недостаточно пар или пригодных временных групп',insufficient_data:'Недостаточно данных',insufficient_overlap:'Недостаточно общих наблюдений',constant:'Постоянная величина',constant_input:'Постоянная величина',no_variation:'Нет вариации',unavailable:'Фактор недоступен',no_data:'Нет данных'};
  return detail.reason?(names[detail.reason]||'Оценка недоступна'):finite(cell.rho)?'':`Корреляция не оценена${finite(cell.n)?` · общих наблюдений ${cell.n}`:''}`;
 }
 function pairCounts(detail,cell){return {overlap:detail.n_overlap??cell.n,used:detail.n_used??(finite(cell.rho)?cell.n:null)};}
 function axisLabel(){return result.imported?.axis||modeLabels[mode];}
 function render(){
  if(!result)return;
  const grid=$('.matrix-grid'),scrollLeft=grid.scrollLeft,scrollTop=grid.scrollTop;
  const factors=fields(),table=element('table'),caption=element('caption',{},`${axisLabel()} · ${platform||'спутник не выбран'} · ρ Спирмена и число пар`);table.append(caption);
  table.style.setProperty('--matrix-column-count',factors.length);
  if(local)table.style.minWidth=`${Math.max(340, 95 + factors.length * 53)}px`;
  const head=element('tr');head.append(element('th',{scope:'col'},'Фактор'));factors.forEach(f=>head.append(protectFactors(element('th',{scope:'col',title:`${f.label}${f.unit?` · ${f.unit}`:''}`},f.short||f.label),f)));
  const thead=element('thead');thead.append(head);table.append(thead);const tbody=element('tbody');
  factors.forEach((factor,i)=>{
   const row=element('tr');row.append(protectFactors(element('th',{scope:'row',title:factor.unit||''},factor.short||factor.label),factor));
   factors.forEach((other,j)=>{
    const cell=cellAt(i,j),detail=detailAt(i,j),counts=pairCounts(detail,cell),countLabel=finite(cell.rho)?`n ${text(counts.used)}`:`общ. ${text(counts.overlap)}`,countDescription=`общих пар ${text(counts.overlap)}, использовано ${text(counts.used)}`,td=element('td'),button=element('button',{type:'button','data-pair':`${i},${j}`,'aria-label':`${factor.label} и ${other.label}: ${finite(cell.rho)?`ρ ${text(cell.rho)}`:reasonLabel(detail,cell)}; ${countDescription}`});
    button.className='matrix-cell'+(pair[0]===i&&pair[1]===j?' selected':'')+(finite(cell.rho)?'':' missing');
    if(finite(cell.rho)){const strength=Math.min(1,Math.abs(cell.rho));button.style.background=`hsl(${cell.rho>=0?24:211} 61% ${16+strength*23}%)`;}
    button.append(element('strong',{},finite(cell.rho)?text(cell.rho):'—'),element('small',{},countLabel));
    button.title=`${reasonLabel(detail,cell)||`${factor.label} / ${other.label} · ρ ${text(cell.rho)}`} · ${countDescription}`;
    protectFactors(button,factor,other);
    button.addEventListener('click',()=>{pair=[i,j];render();grid.querySelector(`[data-pair="${i},${j}"]`)?.focus({preventScroll:true});});td.append(button);row.append(td);
   });tbody.append(row);
  });table.append(tbody);grid.replaceChildren(table);grid.scrollLeft=scrollLeft;grid.scrollTop=scrollTop;
  const definition=local?`Для расчёта ρ нужно не менее ${result.imported.minimum} общих наблюдений.`:mode==='within'?'ρ объединяет связи внутри отдельных месяцев и лет. Сезонность и общий тренд могут отличаться от связи внутри месяцев.':mode==='pooled'?'ρ рассчитана по общим доступным датам всего периода. Общая сезонность может усиливать видимую связь.':'ρ сравнивает участки этой территории. Показатель горения — плотность исходных ячейко-дней; размер участка не равен выгоревшей площади.';
  $('.matrix-definition').replaceChildren(document.createTextNode(definition),document.createTextNode(' n — пары, использованные для оценки ρ; «общ.» — доступные пары до отбора. Обе численности показаны в выбранной паре.'));
  if(pair.some(index=>index>=factors.length))pair=[0,Math.min(1,factors.length-1)];
  renderPair();
 }
 function pairedValues(){
  const factors=fields(),[i,j]=pair;if(!factors[i]||!factors[j])return [];
  const imported=result.imported;
  if(imported)return imported.series.flatMap((row,index)=>{
   const x=row[i],y=row[j];
   return finite(x)&&finite(y)?[{x,y,label:imported.labels[index]}]:[];
  });
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
  const factors=fields(),[i,j]=pair;if(!factors[i]||!factors[j]){$('.matrix-pair').hidden=true;scatter=null;scatterHost.replaceChildren();return;}
  $('.matrix-pair').hidden=false;const cell=cellAt(i,j),detail=detailAt(i,j),points=pairedValues();
  const pairTitle=$('.matrix-pair-title');
  protectFactors(pairTitle,factors[i],factors[j]).textContent=`${factors[i].label} × ${factors[j].label}`;
  const counts=pairCounts(detail,cell);
  const plotPoints=local&&points.length>1500?Array.from({length:1500},(_,i)=>points[Math.floor(i*(points.length-1)/1499)]):points;
  $('.matrix-pair-summary').textContent=`${platform} · ${axisLabel()} · ${finite(cell.rho)?`ρ ${text(cell.rho)}`:reasonLabel(detail,cell)} · общих пар ${text(counts.overlap)} · использовано ${text(counts.used)} · пар на рисунке ${plotPoints.length}`;
  $('.matrix-pair-note').textContent=local?'Пропуски исключены отдельно для каждой пары. При большом числе наблюдений график показывает до 1 500 точек, а ρ считается по всем доступным парам.':mode==='within'?'На рисунке — исходные пары по датам, а ρ выше объединяет внутримесячные связи. Число нарисованных пар может отличаться от n использованных в оценке. Пропуски исключены попарно; они не заменяются нулями.':`Точки показывают реальные ${mode==='space'?'участки':'даты'} с обеими доступными величинами. Пропуски исключены попарно; они не заменяются нулями. Корреляция не устанавливает причину горения.`;
  $('.matrix-on-map').hidden=mode!=='space'||!points.length||bridge.matrixMapAvailable!==true;
  drawScatter(plotPoints,factors[i],factors[j]);
 }
 function drawScatter(points,xFactor,yFactor){
  scatter=points.length?{points,xFactor,yFactor}:null;
  scatterWidth=0;
  if(!scatter){
   scatterHost.replaceChildren(element('p',{class:'matrix-empty'},'Нет общих числовых наблюдений для выбранной пары.'));
   return;
  }
  layoutScatter();
 }
 function layoutScatter(){
  const width=scatterHost.clientWidth;
  if(!scatter||!width||width===scatterWidth)return;
  scatterWidth=width;
  scatterHost.replaceChildren(scatterPlot(scatter,width,width<460?220:260));
 }
 function save(blob,name){const url=URL.createObjectURL(blob),link=element('a',{href:url,download:name});root.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function exportData(type){
  if(!result){status('Сначала рассчитайте матрицу.',true);return;}
  if(type==='json'){save(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),`nasa-space-apps-matrix-${id}.json`);return;}
  const rows=[['matrix_id','analysis_id','platform','mode','factor_x','factor_y','rho','n','reason','n_overlap','n_used','strata_used','mask_sha256','roi','start','end','quality','snapshot_at']];
  if(local)rows[0].push('factor_x_label','factor_y_label');
  for(const name of result.platforms||[])for(const method of ['within','pooled','space']){
   const cells=result.results?.[name]?.[method];
   if(!cells)continue;
   const fs=method==='space'?result.space_factors||[]:result.time_factors||[];
   fs.forEach((a,i)=>fs.forEach((b,j)=>{
    const cell=cells[i]?.[j], detail=result.pair_details?.[name]?.[method]?.[i]?.[j]||{};
    const [rho,n]=Array.isArray(cell)?cell:[cell?.rho,cell?.n];
    const row=[id,analysisId,name,method,a.id,b.id,rho,n,detail.reason,detail.n_overlap,detail.n_used,
     detail.strata_used,detail.mask_sha256,safeCell(roiName(result.config)),result.config?.start,result.config?.end,
     result.config?.quality,result.snapshot_at];
    if(local)row.push(safeCell(a.label),safeCell(b.label));
    rows.push(row);
   }));
  }
  const csv=rows.map(row=>row.map(value=>`"${String(value??'').replaceAll('"','""')}"`).join(',')).join('\r\n');save(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),`nasa-space-apps-matrix-${id}.csv`);
 }
 function exportImage(){
  if(!result||!scatter){status('Выберите пару с числовыми наблюдениями для изображения.',true);return;}
  const width=1120,height=490,doc=svg('svg',{xmlns:svgNS,width,height,viewBox:`0 0 ${width} ${height}`});
  doc.append(svg('rect',{width:'100%',height:'100%',fill:'#07132d'}),svg('style',{},'text{font-family:Arial,sans-serif;fill:#f5f8ff;font-size:12px}'),svg('text',{x:28,y:31,style:'font-size:19px;font-weight:700'},'NASA Space Apps · Связи факторов'),svg('text',{x:28,y:56},$('.matrix-scope').textContent),svg('text',{x:28,y:80},$('.matrix-pair-title').textContent),svg('text',{x:28,y:102},$('.matrix-pair-summary').textContent));
  const plot=scatterPlot(scatter,width-48,270);plot.setAttribute('x',24);plot.setAttribute('y',118);doc.append(plot,svg('text',{x:28,y:414},`Снимок архива ${result.snapshot_at||'не указан'} · матрица ${id}`),svg('text',{x:28,y:437},'Показаны исходные парные наблюдения. Пропуски не заменены нулями. Локальная видимость неизвестна.'),svg('text',{x:28,y:460},'Корреляция не доказывает причину. Для режима внутри месяцев итоговая ρ объединяет отдельные внутримесячные связи.'));
  if(local)for(const label of [doc.children[3],doc.children[4]]) label.setAttribute('translate','no');
  localizeTree(doc);
  save(new Blob([new XMLSerializer().serializeToString(doc)],{type:'image/svg+xml;charset=utf-8'}),`nasa-space-apps-matrix-${platform}-${mode}.svg`);
 }
 function reset(){++epoch;++pollEpoch;id=result=analysisId=restorePlatform=null;startPromise=null;busy=false;pair=[0,1];lastSource=null;hideResults();status(automatic?'Ожидаем данные календаря…':'Матрица рассчитывается отдельно по данным календаря.');refresh();}
 function loadSnapshot(matrixId,snapshot){
  reset();analysisId=getAnalysis()?.id;id=matrixId;
  accept(snapshot);
 }
 function loadFileResult(snapshot){
  id='file';analysisId=snapshot.analysis_id;result=snapshot;mode='pooled';platform=result.platforms[0];
  pair=result.imported.initialPair;
  $('.matrix-scope').textContent=result.imported.fileName+(result.imported.sheet?` · ${result.imported.sheet}`:'');
  $('.matrix-scope').translate=false;
  showResults();render();
 }
 function pause(){paused=true;++pollEpoch;}
 function resume(){paused=false;if(busy&&id&&!result)poll();}
 async function restore(matrixId,state={}){const analysis=getAnalysis();if(!analysis)return;reset();analysisId=analysis.id;id=String(matrixId);busy=true;restorePlatform=state?.platform||null;if(state&&['within','pooled','space'].includes(state.mode)){mode=state.mode;$('.matrix-mode').value=mode;}if(Array.isArray(state?.pair)&&state.pair.length===2&&state.pair.every(index=>Number.isInteger(index)&&index>=0))pair=[...state.pair];refresh();status('Восстанавливаю сохранённую матрицу…');if(!paused)await poll();}
 $('.matrix-run').addEventListener('click',()=>start({refresh:true}));
 $('.matrix-mode').addEventListener('change',()=>{mode=$('.matrix-mode').value;render();});
 $('.matrix-platform').addEventListener('change',()=>{platform=$('.matrix-platform').value;render();onDataChange?.({id,result,platform,analysisId,busy});});
 $('.matrix-export-csv').addEventListener('click',()=>exportData('csv'));$('.matrix-export-json').addEventListener('click',()=>exportData('json'));$('.matrix-export-image').addEventListener('click',exportImage);
 $('.matrix-on-map').addEventListener('click',()=>{const factors=fields();bridge.navigate?.('atlas',{context:getAnalysis()?.context,from:'matrix',matrixPair:{matrixId:id,platform,mode,factor_x:factors[pair[0]]?.id,factor_y:factors[pair[1]]?.id,unitIds:pairedValues().map(point=>point.unit.id)}});});
 refresh();return {refresh,reset,pause,resume,restore,start,loadSnapshot,loadFileResult,setVisible(value){visible=value;if(visible&&result)render();},getState:()=>({id,result,busy,platform,mode,pair:[...pair]}),exportData,exportImage};
}
