import { mountMatrixPanel } from './matrix-panel.js?v=file-matrix';
import { mountFileMatrix } from './matrix-file-panel.js?v=file-matrix';
import { sameScientificConfig } from './scientific-context.js';

const sources = ['Aqua', 'Terra', 'Suomi-NPP', 'NOAA-20', 'NOAA-21'];
const preferred = ['NOAA-20', 'NOAA-21', 'Suomi-NPP', 'Aqua', 'Terra'];
const defaultStudyDates = { start: '2022-01-01', end: '2025-12-31', baseline_start: 2022, baseline_end: 2024 };
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const compactCount = new Intl.NumberFormat('ru', { notation: 'compact', maximumSignificantDigits: 3 });
const monthName = new Intl.DateTimeFormat('ru', { month: 'short', timeZone: 'UTC' });

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function requestCompressedSnapshot(name) {
  const response = await fetch(`data/${name}.json.gz`);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
}

export function createAtlasStudy(root, getPlatform, selectMonth) {
  const $ = (id) => root.querySelector('#' + id);
  const panel = $('atlas-study');
  const status = $('study-status');
  const start = $('study-start'), end = $('study-end');
  const baselineStart = $('study-baseline-start'), baselineEnd = $('study-baseline-end');
  const platform = $('study-platform'), retry = $('study-retry');
  platform.add(new Option('Авто · доступный спутник', 'auto'));
  for (const source of sources) platform.add(new Option(source, source));
  let roi, scopeKey, archive, job, timer, controller, worldSnapshot, worldDownload, worldCalendar, calendarTimer;
  let skoDownload;
  let allWorld = true;
  let explicitDates = false;
  let suspended = false;
  let openTab;
  const analyses = new Map();
  const matrices = new Map();
  const dates = { start, end, baseline_start: baselineStart, baseline_end: baselineEnd };
  for (const input of Object.values(dates)) input.disabled = true;

  function matrixSource() {
    if (platform.value !== 'auto') return platform.value;
    const available = name => job?.result.monthly.some(row => row.platform === name && row.eligible_days > 0);
    const selected = getPlatform();
    return (available(selected) ? selected : preferred.find(available)) || 'NOAA-20';
  }
  const factorsPanel = $('external-factors');
  const importRoot = document.createElement('section');
  const atlasMatrixRoot = document.createElement('div');
  factorsPanel.append(importRoot, atlasMatrixRoot);
  const importedMatrix = mountFileMatrix(importRoot);
  const matrix = mountMatrixPanel(atlasMatrixRoot, {
    request, automatic: true, getAnalysis: () => {
      const analysis = allWorld && !roi ? worldSnapshot?.analysis : job;
      return analysis && { ...analysis, platform: matrixSource() };
    },
    onDataChange: importedMatrix.setAtlas,
  });

  function setScope(next) {
    const key = JSON.stringify(next ?? null);
    if (key === scopeKey) return;
    roi = next;
    scopeKey = key;
    allWorld = !roi;
    $('study-area').textContent = roi?.name || 'Весь мир';
    if (!roi && worldCalendar && !explicitDates) setWorldDates();
    else if (roi && archive && !explicitDates) setArchiveDates();
    $('study-default-period').hidden = Boolean(roi);
    if (roi?.preset === 'sko') loadSkoSnapshot();
    schedule();
  }

  function schedule(delay = roi ? 650 : 0) {
    clearTimeout(timer);
    clearTimeout(calendarTimer);
    controller?.abort();
    job = undefined;
    retry.hidden = true;
    $('study-calendar').replaceChildren();
    $('study-calendar-detail').textContent = '';
    matrix.reset();
    $('study-spinner').hidden = false;
    status.textContent = roi ? 'Готовим календарь и связи для выбранной области…' : 'Загружаем готовый мировой обзор…';
    timer = setTimeout(load, delay);
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
    const years = [...new Set([...byMonth.keys()].map(month => month.slice(0, 4)))].sort().reverse();
    for (const year of years) {
      const line = body.insertRow();
      addHeader(line, year, 'row');
      for (let m = 1; m <= 12; m++) {
        const cell = line.insertCell();
        const key = `${year}-${String(m).padStart(2, '0')}`;
        const rows = byMonth.get(key);
        const metric = job.live ? 'points' : 'cells';
        const row = platform.value === 'auto' ? preferred.map(name => rows?.get(name)).find(item => item?.[metric] != null) : rows?.get(platform.value);
        if (row?.[metric] == null) { cell.textContent = '—'; continue; }
        const button = document.createElement('button');
        button.type = 'button';
        const value = document.createElement('span'), source = document.createElement('span');
        value.className = 'calendar-value';
        value.textContent = row[metric] >= 10000 ? compactCount.format(row[metric]) : number.format(row[metric]);
        source.className = 'calendar-source';
        source.textContent = row.platform === 'Suomi-NPP' ? 'S-NPP' : row.platform;
        if (row.preliminary) {
          button.classList.add('preliminary');
          const badge = document.createElement('span');
          badge.className = 'sr-only';
          badge.textContent = 'NRT';
          source.append(' ', badge);
        }
        const deviation = row.anomaly_pct == null ? 'Историческая норма недоступна'
          : `${row.anomaly_pct > 0 ? '+' : ''}${number.format(row.anomaly_pct)}% к норме`;
        const unit = job.live ? 'детекций' : 'ячейко-дней';
        const quality = row.preliminary ? ' · предварительные данные (NRT)' : '';
        const partial = row.partial ? ' · неполный месяц' : '';
        button.title = `${key} · ${row.platform} · ${number.format(row[metric])} ${unit} · ${deviation}${quality}${partial}`;
        button.style.background = row.anomaly_pct == null ? '#223453' : row.anomaly_pct > 10 ? '#833719' : row.anomaly_pct < -10 ? '#1f507e' : '#263c60';
        button.setAttribute('aria-label', button.title);
        button.append(value, source);
        button.addEventListener('click', () => {
          $('study-calendar-detail').textContent = button.title + (job.live ? '' : ` · ${number.format(row.points)} детекций`);
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
    $('study-calendar-detail').textContent = job.live
      ? 'Детекции FIRMS по спутнику. Цвет показывает отклонение от нормы 2022–2024 при наличии сопоставимых данных. Оранжевая точка означает предварительные данные (NRT). Нажмите месяц, чтобы открыть его на карте.'
      : 'Ячейко-дни · отклонение от нормы по тому же спутнику. Нажмите месяц, чтобы открыть его на карте.';
  }

  function config() {
    if (!archive || !Object.values(dates).every(input => input.value && input.validity.valid) || start.value > end.value || start.value < archive.first || end.value > archive.last) {
      throw new Error('Укажите диапазон дат внутри архива FIRMS.');
    }
    if (baselineStart.valueAsNumber < Number(start.value.slice(0, 4)) || baselineEnd.valueAsNumber > Number(end.value.slice(0, 4))
      || baselineStart.valueAsNumber > baselineEnd.valueAsNumber) {
      throw new Error('Базовые годы должны находиться внутри выбранного периода.');
    }
    return {
      preset: roi?.preset === 'sko' ? 'sko' : roi ? 'custom' : 'world',
      ...(roi && { bbox: roi.bbox, geometry: roi.geometry, circle: roi.circle, roi_name: roi.name.slice(0, 120), roi_source: roi.source?.slice(0, 200) }),
      start: start.value, end: end.value,
      baseline_start: Number(baselineStart.value), baseline_end: Number(baselineEnd.value),
      grid_km: 10, quality: 'sp', daynight: 'all',
    };
  }

  function showJob(analysis, snapshotLabel) {
    job = analysis;
    $('study-spinner').hidden = true;
    const { start, end, grid_km: grid } = job.result.config;
    const snapshotDate = job.result.snapshot_at?.slice(0, 10);
    const prepared = snapshotLabel ? ` ${snapshotLabel} · снимок архива ${snapshotDate}.` : '';
    status.textContent = `${start} — ${end} UTC · SP · сетка ${grid} км · локальная видимость неизвестна.${prepared}`;
    renderCalendar();
    matrix.refresh();
  }

  function setDates(cfg) {
    const bounds = archive ?? cfg;
    start.min = end.min = bounds.first ?? cfg.start;
    start.max = end.max = bounds.last ?? cfg.end;
    for (const [name, input] of Object.entries(dates)) {
      input.value = cfg[name];
      input.disabled = !archive;
    }
    for (const baseline of [baselineStart, baselineEnd]) {
      baseline.min = cfg.start.slice(0, 4);
      baseline.max = cfg.end.slice(0, 4);
    }
  }

  function setArchiveDates() {
    const preferredDates = worldSnapshot?.analysis.result.config ?? defaultStudyDates;
    const first = preferredDates.start < archive.first ? archive.first : preferredDates.start;
    const last = preferredDates.end > archive.last ? archive.last : preferredDates.end;
    const range = first <= last ? { start: first, end: last } : { start: archive.first, end: archive.last };
    const year = Number(range.start.slice(0, 4));
    setDates({ ...range, baseline_start: year, baseline_end: Math.min(year + 2, Number(range.end.slice(0, 4))) });
  }

  function setWorldDates() {
    setDates({ start: worldCalendar.start, end: worldCalendar.end, baseline_start: 2022, baseline_end: 2024 });
  }

  async function refreshWorld(signal) {
    try {
      const data = await request('/api/v1/world-calendar', { signal });
      if (signal.aborted) return;
      if (data.monthly?.length && (data.revision !== worldCalendar?.revision || !job?.live)) presentWorld(data);
      calendarTimer = setTimeout(() => refreshWorld(signal), data.monthly ? 60_000 : 6000);
    } catch {
      if (!signal.aborted) calendarTimer = setTimeout(() => refreshWorld(signal), 15_000);
    }
  }

  function presentWorld(data) {
    worldCalendar = data;
    if (archive && data.end > archive.last) archive.last = data.end;
    setWorldDates();
    job = { live: true, result: { config: { start: data.start, end: data.end }, monthly: data.monthly } };
    $('study-spinner').hidden = true;
    worldStatus();
    renderCalendar();
  }

  function worldStatus() {
    if (openTab === '#external-factors' && worldSnapshot) {
      const { start, end } = worldSnapshot.analysis.result.config;
      status.textContent = `${start} — ${end} UTC · связи факторов по исторической выборке`;
    } else if (job?.live) {
      status.textContent = `${worldCalendar.start} — ${worldCalendar.end} UTC · детекции SP и NRT`;
    }
  }

  function loadDefault() {
    const download = async () => {
      if ('DecompressionStream' in window) {
        try {
          return await requestCompressedSnapshot('world-atlas');
        } catch { /* Older deployments and browsers can use the JSON copy. */ }
      }
      return request('data/world-atlas.json');
    };
    worldDownload ??= download().then(snapshot => {
      if (snapshot.analysis?.result?.config?.preset !== 'world' || !snapshot.matrix?.result) {
        throw new Error('Готовый мировой обзор временно недоступен.');
      }
      worldSnapshot = snapshot;
      return snapshot;
    }).catch(error => {
      worldDownload = undefined;
      throw error;
    });
    return worldDownload;
  }

  function loadSkoSnapshot() {
    if (!('DecompressionStream' in window)) return null;
    skoDownload ??= requestCompressedSnapshot('sko-study').then(snapshot => {
      const analysis = snapshot.analysis?.result;
      const factors = snapshot.matrix?.result;
      if (analysis?.config?.preset !== 'sko' || !analysis.monthly?.length || !factors
          || factors.analysis_id !== snapshot.analysis.id || factors.extract_id !== analysis.extract_id
          || factors.snapshot_at !== analysis.snapshot_at || !sameScientificConfig(analysis.config, factors.config)) {
        throw new Error('Готовый снимок СКО не совпадает с параметрами матрицы.');
      }
      return snapshot;
    }).catch(() => {
      skoDownload = undefined;
      return null;
    });
    return skoDownload;
  }

  async function load() {
    if (suspended) return;
    if (roi && !openTab) {
      $('study-spinner').hidden = true;
      status.textContent = 'Откройте календарь или перейдите к условиям исследования выбранной территории.';
      return;
    }
    const signal = (controller = new AbortController()).signal;
    let key;
    if (!roi && allWorld) {
      if (worldCalendar) presentWorld(worldCalendar);
      else request('data/world-calendar.json', { signal }).then(data => {
        if (!signal.aborted && !job?.live && data.monthly?.length) presentWorld(data);
      }).catch(() => {});
      refreshWorld(signal);
      try {
        const snapshot = await loadDefault();
        if (signal.aborted) return;
        if (!job) {
          setDates(snapshot.analysis.result.config);
          showJob(snapshot.analysis, 'Готовый мировой обзор · 85° ю. ш. — 85° с. ш.');
          status.textContent = '2022–2025 · загружается полный архив…';
          $('study-spinner').hidden = false;
        }
        matrix.loadSnapshot(snapshot.matrix.id, snapshot.matrix.result);
        worldStatus();
      } catch (error) {
        if (!signal.aborted && !job) status.textContent = error.message;
      }
      return;
    }
    try {
      const snapshot = await loadDefault().catch(error => {
        if (!roi) throw error;
        return null;
      });
      if (signal.aborted) return;
      const defaults = snapshot?.analysis.result.config ?? defaultStudyDates;
      if (!start.value) setDates(defaults);
      if (!archive) return;
      const body = config();
      if (body.preset === 'sko') {
        const prepared = await loadSkoSnapshot();
        if (signal.aborted) return;
        const savedConfig = prepared?.analysis.result.config;
        // The API always uses the canonical SKO boundary; the map has a simplified copy.
        if (savedConfig && sameScientificConfig({ ...body, bbox: savedConfig.bbox }, savedConfig)) {
          showJob(prepared.analysis, 'Готовый расчёт СКО');
          matrix.loadSnapshot(prepared.matrix.id, prepared.matrix.result);
          return;
        }
      }
      key = JSON.stringify(body);
      if (!analyses.has(key)) {
        const created = request('/api/v1/analyses', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key,
        }).then(job => job.id);
        analyses.set(key, created);
        if (analyses.size > 20) analyses.delete(analyses.keys().next().value);
      }
      const id = await analyses.get(key);
      let progress;
      while (!signal.aborted) {
        progress = await request(`/api/v1/analyses/${encodeURIComponent(id)}?view=calendar`, { signal });
        if (signal.aborted || !['queued', 'running'].includes(progress.status)) break;
        status.textContent = progress.message || 'Готовим календарь…';
        await new Promise(resolve => setTimeout(resolve, 1250));
      }
      if (signal.aborted) return;
      if (progress.status !== 'done' || !progress.result) throw new Error(progress.message || 'Расчёт календаря не завершился.');
      showJob({ id, result: progress.result });
      const saved = matrices.get(id);
      if (saved) await matrix.restore(saved);
      else await matrix.start();
      if (signal.aborted) return;
      const finished = matrix.getState();
      if (finished.result) {
        matrices.set(id, finished.id);
        if (matrices.size > 20) matrices.delete(matrices.keys().next().value);
      } else {
        matrices.delete(id);
        retry.hidden = false;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (key && !job) analyses.delete(key);
      status.textContent = error.message;
      $('study-spinner').hidden = true;
      retry.hidden = false;
    }
  }

  retry.addEventListener('click', () => schedule(0));
  $('study-default-period').addEventListener('click', () => {
    allWorld = true;
    explicitDates = false;
    schedule(0);
  });
  for (const input of [start, end]) input.addEventListener('change', () => {
    allWorld = false;
    explicitDates = true;
    if (start.value && end.value && start.value <= end.value) {
      const first = Number(start.value.slice(0, 4));
      const last = Number(end.value.slice(0, 4));
      for (const baseline of [baselineStart, baselineEnd]) {
        baseline.min = first;
        baseline.max = last;
        baseline.value = Math.min(last, Math.max(first, baseline.valueAsNumber || first));
      }
    }
    schedule(750);
  });
  for (const input of [baselineStart, baselineEnd]) input.addEventListener('change', () => { allWorld = false; explicitDates = true; schedule(750); });
  platform.addEventListener('change', () => { renderCalendar(); matrix.refresh(); });

  return {
    setScope,
    pause() {
      suspended = true;
      clearTimeout(timer);
      clearTimeout(calendarTimer);
      controller?.abort();
      matrix.pause();
    },
    resume() {
      suspended = false;
      matrix.resume();
      if ((!roi && allWorld) || (openTab && !job)) schedule(0);
    },
    getSettings() {
      if (!start.value || !end.value) return null;
      return { start:start.value, end:end.value, baseline_start:baselineStart.valueAsNumber,
        baseline_end:baselineEnd.valueAsNumber, platform:platform.value, explicit:explicitDates };
    },
    restoreSettings(value) {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(value.end || '')
          || !Number.isInteger(value.baseline_start) || !Number.isInteger(value.baseline_end)) return;
      const previous = JSON.stringify([start.value,end.value,baselineStart.valueAsNumber,baselineEnd.valueAsNumber,platform.value]);
      setDates(value);
      if (value.platform === 'auto' || sources.includes(value.platform)) platform.value = value.platform;
      explicitDates = value.explicit !== false;
      if (explicitDates) allWorld = false;
      const next = JSON.stringify([start.value,end.value,baselineStart.valueAsNumber,baselineEnd.valueAsNumber,platform.value]);
      if (next !== previous) schedule();
    },
    setArchive(value) {
      archive = value;
      start.min = end.min = archive.first;
      start.max = end.max = archive.last;
      if (!start.value || (!explicitDates && (end.value > archive.last || start.value < archive.first))) {
        if (roi) setArchiveDates();
        else setDates(worldSnapshot?.analysis.result.config ?? defaultStudyDates);
      }
      for (const input of Object.values(dates)) input.disabled = false;
      if (roi) schedule();
    },
    show(tab) {
      openTab = tab;
      panel.hidden = !tab;
      $('activity-calendar').hidden = tab !== '#activity-calendar';
      $('external-factors').hidden = tab !== '#external-factors';
      matrix.setVisible(tab === '#external-factors');
      if (roi && !tab) {
        clearTimeout(timer);
        controller?.abort();
        $('study-spinner').hidden = true;
      } else if (roi && !job) schedule(0);
      if (!roi && allWorld) worldStatus();
    },
  };
}
