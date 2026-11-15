const seenKey = 'nasa-space-apps-onboarding-v1';
const resumeKey = 'nasa-space-apps-tour-v1';
const exampleId = '7ad1819ace34dfa2fd5a498a7eda3db7';
const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
const write = (storage, key, value) => { try { value == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* Guidance works without storage. */ } };
const welcome = document.createElement('dialog');
welcome.className = 'onboarding-dialog onboarding-welcome';
welcome.id = 'onboarding-welcome';
welcome.setAttribute('aria-labelledby', 'onboarding-title');
welcome.innerHTML = `<p class="onboarding-kicker">Первое исследование</p>
  <h2 id="onboarding-title">Этот месяц необычный — или такой сезон бывает каждый год?</h2>
  <p>Выберите территорию и сравните спутниковые сигналы горения с историей того же времени года. Приложение покажет результат и объяснит, хватает ли данных для вывода.</p>
  <div class="onboarding-steps"><span>Территория</span><span aria-hidden="true">→</span><span>Вопрос</span><span aria-hidden="true">→</span><span>Условия</span><span aria-hidden="true">→</span><span>Результат</span></div>
  <p>Начните с готового исследования: сначала разберём результат, затем пройдём шаги для вашей территории.</p>
  <p class="onboarding-muted">Спутниковые сигналы не равны числу отдельных пожаров. Пропуски наблюдений и ограничения будут показаны рядом с выводом.</p>
  <p id="onboarding-status" role="status" aria-live="polite"></p>
  <div class="onboarding-actions"><button type="button" class="onboarding-primary" id="onboarding-demo">Разобрать готовый пример</button><button type="button" id="onboarding-own">Своё исследование</button></div>
  <button type="button" class="onboarding-dismiss" id="onboarding-skip">Пропустить · тур останется в «Как пользоваться»</button>`;
const card = document.createElement('dialog');
card.className = 'onboarding-dialog onboarding-card';
card.id = 'onboarding-card';
card.setAttribute('aria-labelledby', 'onboarding-step-title');
card.setAttribute('aria-modal', 'false');
card.innerHTML = `<button class="onboarding-close" type="button" aria-label="Завершить тур">×</button><span id="onboarding-progress" class="onboarding-kicker"></span><h2 id="onboarding-step-title"></h2><p id="onboarding-step-text"></p><p id="onboarding-wait" class="onboarding-muted" role="status"></p><div class="onboarding-actions"><button type="button" id="onboarding-back">Назад</button><button type="button" class="onboarding-primary" id="onboarding-next">Дальше</button></div>`;
document.body.append(welcome, card);

const flows = {
  demo: [
    { target:'#anomaly-value', title:'Сначала — ответ на вопрос', text:'«Отклонение» показывает, насколько активность выбранного месяца выше или ниже его исторического уровня. Плюс означает выше, минус — ниже. Это сравнение спутниковых сигналов, а не подсчёт пожаров.', ready:'#study-results:not([hidden])' },
    { target:'#study-assessment', title:'Можно ли делать такое сравнение?', text:'Здесь проверяется, хватает ли истории и выполнены ли условия сравнения. Откройте «Основания и ограничения»: отсутствие оценки означает недостаток данных. Локальная облачность и видимость пока неизвестны.' },
    { target:'#focus-month', title:'Посмотрите другой месяц', text:'Выберите месяц здесь или в календаре ниже. Значение, историческая база и пояснение относятся к выбранному месяцу. Сезонность помогает отличить обычный ежегодный подъём от необычного периода.' },
    { target:'#preset', title:'Теперь — ваша территория', text:'В примере использована Северо-Казахстанская область. Для своего исследования можно выбрать другой регион мира или выделить область на карте. Дальше проведём вас по настройке.' },
  ],
  setup: [
    { target:'#preset', title:'1. Где вы хотите разобраться?', text:'Выберите территорию из списка. Для своего участка воспользуйтесь «Выделить прямоугольник на карте» или выделением в атласе. Все дальнейшие результаты относятся к этой границе.' },
    { target:'#study-question', title:'2. Что вы хотите узнать?', text:'Начните с «Необычен ли выбранный период?». Другие вопросы помогут сравнить два года или проверить согласование спутников. Вы можете менять настройки прямо во время тура.' },
    { target:'#study-plan-request', title:'3. Получите условия сравнения', text:'Нажмите «Предложить условия». Приложение посмотрит доступность истории и предложит варианты. На этом шаге пространственный расчёт ещё не запускается.' },
    { target:'#study-plan-options', fallback:'#study-applied', title:'4. Осознанно выберите вариант', text:'Прочитайте, какие даты, базовые годы и источник предлагаются и почему. Нажмите «Выбрать условия» у подходящего варианта. Его параметры появятся в блоке «Условия выбраны».', wait:'Если вариантов ещё нет, нажмите «Предложить условия» и дождитесь ответа. При ошибке можно повторить подбор.' },
    { target:'#run', fallback:'#study-applied', title:'5. Запустите и прочитайте результат', text:'После выбора условий нажмите «Построить анализ». Новый расчёт может занять несколько минут. Затем посмотрите отклонение и проверку результата. Версию можно сохранить и позже сравнить с новой.', wait:'Кнопка расчёта появится после выбора условий. Тур сам не запускает вычисления.' },
  ],
};
let current = null;
let highlighted;
let observed;
let raf;
let returnFocus;
const visible = selector => [...document.querySelectorAll(selector)].find(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; });

function clearTarget() { highlighted?.classList.remove('onboarding-target'); highlighted = null; }
function place() {
  if (!current || !card.open) return;
  const step = flows[current.flow][current.index];
  const target = (!step.ready || visible(step.ready)) && (visible(step.target) || (step.fallback && visible(step.fallback)));
  if (target !== highlighted) { clearTarget(); highlighted = target || null; highlighted?.classList.add('onboarding-target'); highlighted?.scrollIntoView({block:'center',behavior:'instant'}); }
  card.querySelector('#onboarding-wait').textContent = target ? '' : step.wait || 'Дождитесь открытия исследования. Если данные недоступны, закройте тур и повторите открытие примера.';
  card.style.top = 'auto'; card.style.bottom = '14px';
  if (highlighted) {
    const box = highlighted.getBoundingClientRect();
    const cardHeight = card.getBoundingClientRect().height;
    const overlap = box.bottom > innerHeight - cardHeight - 30 && box.top < innerHeight;
    if (overlap && box.top > 80 + cardHeight) { card.style.bottom = 'auto'; card.style.top = 'calc(var(--app-header-height, 56px) + 12px)'; }
  }
}
function renderStep() {
  const list = flows[current.flow], step = list[current.index];
  write(sessionStorage, resumeKey, current);
  card.querySelector('#onboarding-progress').textContent = `${current.flow === 'demo' ? 'Готовый пример' : 'Ваше исследование'} · ${current.index + 1} из ${list.length}`;
  card.querySelector('#onboarding-step-title').textContent = step.title;
  card.querySelector('#onboarding-step-text').textContent = step.text;
  card.querySelector('#onboarding-back').disabled = current.index === 0;
  card.querySelector('#onboarding-next').textContent = current.index === list.length - 1 ? current.flow === 'demo' ? 'К своему исследованию' : 'Понятно, начинаю' : 'Дальше';
  if (!card.open) card.show();
  const target = (!step.ready || visible(step.ready)) && visible(step.target);
  target?.scrollIntoView({ block:'center', behavior:'instant' });
  place();
}
function finish() {
  current = null; clearTarget(); card.close(); observed?.disconnect(); observed = null;
  write(sessionStorage, resumeKey, null); write(localStorage, seenKey, true);
  if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
}
function start(flow, index = 0) {
  welcome.close(); current = {flow, index}; write(localStorage, seenKey, true);
  observed?.disconnect();
  observed = new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); });
  observed.observe(document.querySelector('#app-outlet'), {childList:true, subtree:true, attributes:true, attributeFilter:['hidden','disabled']});
  renderStep();
}
function ownStudy() {
  if (!visible('#analysis-form')) document.querySelector('[data-app-view="analysis"]').click();
  start('setup');
}
function showWelcome() {
  returnFocus = document.activeElement;
  finish(); welcome.querySelector('#onboarding-status').textContent = '';
  welcome.showModal();
}
card.querySelector('.onboarding-close').addEventListener('click', finish);
card.addEventListener('cancel', event => { event.preventDefault(); finish(); });
card.querySelector('#onboarding-back').addEventListener('click', () => { if (current.index > 0) { current.index--; renderStep(); } });
card.querySelector('#onboarding-next').addEventListener('click', () => {
  if (current.index + 1 < flows[current.flow].length) { current.index++; renderStep(); }
  else if (current.flow === 'demo') ownStudy();
  else finish();
});
welcome.querySelector('#onboarding-own').addEventListener('click', ownStudy);
welcome.querySelector('#onboarding-skip').addEventListener('click', () => { welcome.close(); finish(); });
welcome.addEventListener('cancel', () => { write(localStorage, seenKey, true); });
document.querySelector('#app-tour-open').addEventListener('click', showWelcome);
addEventListener('resize', place);
addEventListener('scroll', place, {capture:true, passive:true});

welcome.querySelector('#onboarding-demo').addEventListener('click', async event => {
  const button = event.currentTarget, status = welcome.querySelector('#onboarding-status');
  button.disabled = true; status.className = ''; status.textContent = 'Открываем готовое исследование. Новый расчёт не запускается.';
  try {
    const response = await fetch(`/api/v1/analyses/${exampleId}`);
    if (!response.ok) throw new Error('Пример сейчас недоступен. Можно начать своё исследование или повторить открытие.');
    const job = await response.json(); if (job.status !== 'done' || !job.result?.config) throw new Error('Пример пока не готов. Выберите «Своё исследование».');
    const result = job.result, c = result.config;
    const choices = result.monthly.filter(row => row.platform === 'Aqua' && row.comparison_status === 'ok' && row.baseline > 0);
    const month = choices.find(row => row.month === '2025-04')?.month || choices.at(-1)?.month;
    if (!month) throw new Error('В этом примере нет пригодного месяца для объяснения. Выберите «Своё исследование».');
    const context = {roi:{preset:c.preset,bbox:c.bbox,name:c.roi_name || 'Северо-Казахстанская область',...(c.geometry ? {geometry:c.geometry} : {}),...(c.circle ? {circle:c.circle} : {})},
      history:{start:c.start,end:c.end},baseline:{start:c.baseline_start,end:c.baseline_end},focus:null,platform:'Aqua',grid_km:c.grid_km,quality:c.quality,daynight:c.daynight,study:{question:'anomaly'}};
    const state = {version:1,context,analysisId:exampleId,month,tab:'calendar',seriesMode:'raw',study:{question:'anomaly'}};
    const url = new URL(location.href); url.search = ''; url.hash = '';
    url.searchParams.set('view','analysis'); url.searchParams.set('analysis_id',exampleId); url.searchParams.set('state',JSON.stringify(state));
    write(localStorage, seenKey, true); write(sessionStorage, resumeKey, {flow:'demo',index:0});
    location.assign(url);
  } catch (error) { status.className = 'onboarding-error'; status.textContent = error.message; }
  finally { button.disabled = false; }
});

const resume = read(sessionStorage, resumeKey);
if (resume && flows[resume.flow] && Number.isInteger(resume.index) && resume.index >= 0 && resume.index < flows[resume.flow].length) start(resume.flow, resume.index);
else {
  const url = new URL(location.href), shared = ['state','analysis_id','analysis'].some(key => url.searchParams.has(key));
  if (!shared && !read(localStorage, seenKey)) showWelcome();
}
