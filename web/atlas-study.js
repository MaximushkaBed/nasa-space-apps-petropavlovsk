import { mountMatrixPanel } from './matrix-panel.js?v=territory';
import { addDays } from './period-picker.js';

const sources = ['Aqua', 'Terra', 'Suomi-NPP', 'NOAA-20', 'NOAA-21'];
const preferred = ['NOAA-20', 'NOAA-21', 'Suomi-NPP', 'Aqua', 'Terra'];
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const monthName = new Intl.DateTimeFormat('ru', { month: 'short', timeZone: 'UTC' });

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function createAtlasStudy(root, getPlatform, selectMonth) {
  const $ = (id) => root.querySelector('#' + id);
  const panel = $('atlas-study');
  const status = $('study-status');
  const start = $('study-start'), end = $('study-end');
  const baselineStart = $('study-baseline-start'), baselineEnd = $('study-baseline-end');
  const platform = $('study-platform');
  platform.add(new Option('Авто · доступный спутник', 'auto'));
  for (const source of sources) platform.add(new Option(source, source));
  let roi, scopeKey, archive, current, job, generation = 0;

  function matrixSource() {
    if (platform.value !== 'auto') return platform.value;
    const available = name => job?.result.monthly.some(row => row.platform === name && row.eligible_days > 0);
    const selected = getPlatform();
    return (available(selected) ? selected : preferred.find(available)) || 'NOAA-20';
  }
  const matrix = mountMatrixPanel($('external-factors'), {
    request, getAnalysis: () => job && { ...job, platform: matrixSource() },
  });

  function setScope(next) {
    const key = JSON.stringify(next ?? null);
    if (key === scopeKey) return;
    roi = next;
    scopeKey = key;
    $('study-area').textContent = roi?.name || 'Весь мир';
    invalidate();
  }

  function invalidate() {
    ++generation;
    current = job = undefined;
    $('study-run').disabled = !archive;
    $('study-calendar').replaceChildren();
    $('study-calendar-detail').textContent = '';
    status.textContent = roi ? 'Рассчитайте активность внутри границы.'
      : 'Мировой обзор · сетка 250 км · широты 85° ю. ш. — 85° с. ш. Первый расчёт может занять несколько минут.';
    matrix.reset();
  }

  function renderCalendar() {
    if (!job) return;
    const byMonth = new Map();
    for (const row of job.result.monthly) {
      if (!byMonth.has(row.month)) byMonth.set(row.month, new Map());
      byMonth.get(row.month).set(row.platform, row);
    }
    const table = document.createElement('table');
    table.className = 'calendar';
    const header = table.createTHead().insertRow();
    const addHeader = (row, label, scope) => {
      const cell = document.createElement('th');
      cell.textContent = label;
      cell.scope = scope;
      row.append(cell);
    };
    addHeader(header, 'UTC', 'col');
    for (let m = 1; m <= 12; m++) addHeader(header, monthName.format(new Date(Date.UTC(2024, m - 1, 1))), 'col');
    const body = table.createTBody();
    const years = new Set([...byMonth.keys()].map(month => month.slice(0, 4)));
    for (const year of years) {
      const line = body.insertRow();
      addHeader(line, year, 'row');
      for (let m = 1; m <= 12; m++) {
        const cell = line.insertCell();
        const key = `${year}-${String(m).padStart(2, '0')}`;
        const rows = byMonth.get(key);
        const row = platform.value === 'auto' ? preferred.map(name => rows?.get(name)).find(item => item?.cells != null) : rows?.get(platform.value);
        if (row?.cells == null) { cell.textContent = '—'; continue; }
        const button = document.createElement('button');
        button.type = 'button';
        const value = document.createElement('span'), source = document.createElement('span');
        value.textContent = number.format(row.cells);
        source.className = 'calendar-source';
        source.textContent = row.platform;
        const deviation = row.anomaly_pct == null ? 'Историческая норма недоступна'
          : `${row.anomaly_pct > 0 ? '+' : ''}${number.format(row.anomaly_pct)}% к норме`;
        button.title = `${key} · ${row.platform} · ${number.format(row.cells)} ячейко-дней · ${deviation}`;
        button.style.background = row.anomaly_pct == null ? '#223453' : row.anomaly_pct > 10 ? '#833719' : row.anomaly_pct < -10 ? '#1f507e' : '#263c60';
        button.setAttribute('aria-label', button.title);
        button.append(value, source);
        button.addEventListener('click', () => {
          $('study-calendar-detail').textContent = button.title + ` · ${number.format(row.points)} детекций`;
          table.querySelector('[aria-current]')?.removeAttribute('aria-current');
          button.setAttribute('aria-current', 'date');
          const first = `${key}-01`;
          const last = new Date(Date.UTC(Number(year), m, 0)).toISOString().slice(0, 10);
          selectMonth({ start: first < job.result.config.start ? job.result.config.start : first,
            end: last > job.result.config.end ? job.result.config.end : last, mode: 'month' }, row.platform);
        });
        cell.append(button);
      }
    }
    $('study-calendar').replaceChildren(table);
    $('study-calendar-detail').textContent = 'Ячейко-дни: число ячеек с сигналом за сутки, суммированное за месяц. Отклонение считается по тому же спутнику. При смене спутника в режиме «Авто» меняется источник исходных значений. Нажмите месяц, чтобы открыть его на карте.';
  }

  function config() {
    if (!archive || !start.value || !end.value || start.value > end.value || start.value < archive.first || end.value > archive.last) {
      throw new Error('Укажите диапазон дат внутри архива FIRMS.');
    }
    return {
      preset: roi?.preset === 'sko' ? 'sko' : roi ? 'custom' : 'world',
      ...(roi && { bbox: roi.bbox, geometry: roi.geometry, circle: roi.circle, roi_name: roi.name.slice(0, 120), roi_source: roi.source?.slice(0, 200) }),
      start: start.value, end: end.value,
      baseline_start: Number(baselineStart.value), baseline_end: Number(baselineEnd.value),
      grid_km: 10, quality: 'sp', daynight: 'all',
    };
  }

  async function run() {
    if (current) return current;
    let body;
    try { body = config(); } catch (error) { status.textContent = error.message; return; }
    const button = $('study-run');
    if (job) invalidate();
    const revision = ++generation;
    button.disabled = true;
    status.textContent = 'Отправляем запрос к архиву FIRMS…';
    current = (async () => {
      try {
        let progress = await request('/api/v1/analyses', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const { id } = progress;
        while (revision === generation && (progress.status === 'queued' || progress.status === 'running')) {
          status.textContent = progress.message || 'Расчёт в очереди…';
          await new Promise(resolve => setTimeout(resolve, 1100));
          if (revision !== generation) return;
          progress = await request(`/api/v1/analyses/${encodeURIComponent(id)}`);
        }
        if (revision !== generation) return;
        if (progress.status !== 'done' || !progress.result) throw new Error(progress.message || 'Расчёт не завершился.');
        job = { id, result: progress.result };
        status.textContent = `${body.start} — ${body.end} UTC · SP · ${job.result.config.grid_km} км · локальная видимость неизвестна.`;
        renderCalendar();
        matrix.refresh();
      } catch (error) {
        if (revision === generation) status.textContent = error.message;
      } finally {
        if (revision === generation) { current = undefined; button.disabled = false; }
      }
    })();
    return current;
  }

  $('study-run').addEventListener('click', run);
  for (const input of [start, end, baselineStart, baselineEnd]) input.addEventListener('change', invalidate);
  platform.addEventListener('change', () => { renderCalendar(); matrix.refresh(); });

  return {
    setScope,
    setArchive(value) {
      archive = value;
      const complete = addDays(archive.last, -1);
      const year = Number(complete.slice(0, 4));
      const endYear = year - 1;
      start.min = end.min = archive.first;
      start.max = end.max = archive.last;
      start.value = `${endYear - 3}-01-01` < archive.first ? archive.first : `${endYear - 3}-01-01`;
      end.value = `${endYear}-12-31` >= start.value ? `${endYear}-12-31` : archive.last;
      baselineStart.value = start.value.slice(0, 4);
      baselineEnd.value = String(Math.min(Number(end.value.slice(0, 4)), Number(baselineStart.value) + 2));
      invalidate();
    },
    show(tab) {
      panel.hidden = !tab;
      $('activity-calendar').hidden = tab !== '#activity-calendar';
      $('external-factors').hidden = tab !== '#external-factors';
      matrix.setVisible(tab === '#external-factors');
      $('study-run').textContent = tab === '#external-factors' ? 'Подготовить данные для матрицы' : 'Рассчитать календарь';
    },
  };
}
