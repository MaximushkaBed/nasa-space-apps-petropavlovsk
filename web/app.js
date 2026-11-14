'use strict';

import { createExtraLayers } from './map-layers.js?v=sko-atlas';
import { createWeatherOverlay } from './weather-overlay.js?v=sko-atlas';

const $ = (id) => document.getElementById(id);
const sources = ['Aqua / MODIS', 'Suomi NPP / VIIRS', 'NOAA-20 / VIIRS'];
const sourceTags = ['MODIS', 'Suomi', 'NOAA‑20'];
const monthNames = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const fullMonths = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });
const unsignedPercent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 0 });
const activityKey = [['activity-0', '0'], ['activity-1', 'до 10'], ['activity-2', '10–49'], ['activity-3', '50–149'], ['activity-4', '150–399'], ['activity-5', '400+']];
const deviationKey = [['below-2', '−50% и ниже'], ['below-1', 'ниже нормы'], ['near-norm', 'в пределах ±10%'], ['above-1', 'выше нормы'], ['above-2', '+50% и выше']];

let calendar;
let map;
let region;
let cellLayer;
let weatherOverlay;
let displayedDay = null;
let displayedMonth = null;
let playbackTimer;
let layerRequest = 0;
let renderExtraLayers;
let weatherData;
let monthIndex;
let source = 'unified';
let mode = 'deviation';
let mapRequest = 0;
let mapAvailable;
const cachedCells = new Map();

function periodLabel(key) {
  const [year, month] = key.split('-');
  return `${fullMonths[Number(month) - 1]} ${year}`;
}

const dayFormatter = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function frameDate(month, day) {
  return `${month}-${String(day).padStart(2, '0')}`;
}

function monthSource(row) {
  return source === 'unified' ? row.source : Number(source);
}

function element(tag, label, className) {
  const node = document.createElement(tag);
  if (label !== undefined) node.textContent = label;
  if (className) node.className = className;
  return node;
}

async function getJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response.json();
}

function addTerrainControl(map) {
  const pane = map.createPane('terrain-shading');
  pane.style.zIndex = 405;
  pane.style.pointerEvents = 'none';
  const toggle = $('terrain-layer');
  const opacity = $('terrain-opacity');
  const strength = opacity.closest('label');
  const status = $('terrain-status');
  const tiles = L.tileLayer('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/ASTER_GDEM_Greyscale_Shaded_Relief/default/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg', {
    pane: 'terrain-shading', noWrap: true, maxNativeZoom: 12, maxZoom: 12,
    opacity: opacity.valueAsNumber / 100,
    attribution: '<a href="https://worldview.earthdata.nasa.gov/?l=ASTER_GDEM_Greyscale_Shaded_Relief">ASTER GDEM · NASA GIBS</a>',
  });
  tiles.on('loading', () => { status.hidden = true; });
  tiles.on('tileerror', () => { status.hidden = false; });
  const showTerrain = () => {
    strength.hidden = !toggle.checked;
    if (toggle.checked) tiles.addTo(map);
    else {
      tiles.remove();
      status.hidden = true;
    }
  };
  toggle.addEventListener('change', showTerrain);
  opacity.addEventListener('input', () => tiles.setOpacity(opacity.valueAsNumber / 100));
  $('terrain-controls').disabled = false;
  showTerrain();
}

function createMap(basemap, boundary) {
  const styles = {
    country: { color: '#7890a0', weight: 1.1, fillColor: '#162846', fillOpacity: 1 },
    province: { color: '#74838e', weight: .65, opacity: .58, dashArray: '3 4' },
    road: { color: '#84959f', weight: .6, opacity: .37 },
    lake: { color: '#6098b1', weight: .75, fillColor: '#193c58', fillOpacity: 1 },
    river: { color: '#6498af', weight: .85, opacity: .67 },
  };
  map = L.map('map', {
    zoomControl: false, minZoom: 5, maxZoom: 12, zoomSnap: .25,
    maxBounds: [[47, 58], [60, 83]], maxBoundsViscosity: .8, zoomAnimation: false,
  });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('<a href="https://www.naturalearthdata.com/">Natural Earth</a> · <a href="https://www.geoboundaries.org/">geoBoundaries</a>');
  const satellite = L.imageOverlay('assets/sko-blue-marble.webp', [[46, 57], [61, 84]], {
    className: 'satellite-image',
    pane: 'tilePane', zIndex: 2,
    attribution: '<a href="https://nasa-gibs.github.io/gibs-api-docs/">Blue Marble · NASA GIBS</a>',
  });
  const world = L.imageOverlay('assets/world-blue-marble.webp', [[-85.0511288, -180], [85.0511288, 180]], {
    pane: 'tilePane', zIndex: 1,
    attribution: '<a href="https://nasa-gibs.github.io/gibs-api-docs/">Blue Marble · NASA GIBS</a>',
  });
  const worldDetails = L.tileLayer('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg', {
    noWrap: true, minZoom: 3, maxNativeZoom: 8, maxZoom: 12, zIndex: 2,
  });
  map.createPane('local-geography').style.zIndex = 401;
  const geography = L.geoJSON(basemap, {
    pane: 'local-geography',
    filter: (feature) => feature.properties.style !== 'city',
    style: (feature) => {
      const style = styles[feature.properties.style];
      return feature.properties.country === 'RUS' ? { ...style, fillColor: '#1b3154' } : style;
    },
    interactive: false,
  }).addTo(map);

  region = L.geoJSON(boundary, { interactive: false, style: {
    color: '#c4e0fb', weight: 1.65, opacity: .94, fillColor: '#4776aa', fillOpacity: .13, dashArray: '5 4',
  } }).addTo(map);
  const setBasemap = (useSatellite) => {
    if (useSatellite) satellite.addTo(map);
    else satellite.remove();
    if (map.hasLayer(world)) {
      if (useSatellite) worldDetails.addTo(map);
      else worldDetails.remove();
    }
    geography.eachLayer((layer) => {
      const style = layer.feature.properties.style;
      if (style === 'country' || style === 'lake') layer.setStyle({ fillOpacity: useSatellite ? 0 : 1 });
    });
    $('satellite-view').setAttribute('aria-pressed', String(useSatellite));
    $('vector-view').setAttribute('aria-pressed', String(!useSatellite));
  };
  $('satellite-view').addEventListener('click', () => setBasemap(true));
  $('vector-view').addEventListener('click', () => setBasemap(false));
  $('satellite-view').disabled = false;
  $('vector-view').disabled = false;
  satellite.once('error', () => {
    setBasemap(false);
    $('satellite-view').disabled = true;
    $('satellite-view').title = 'Снимок недоступен';
  });
  setBasemap(true);
  const activityPane = map.createPane('activity-cells');
  activityPane.style.zIndex = 415;
  const heatCanvas = L.canvas({ padding: .5, pane: 'activity-cells' });
  cellLayer = L.featureGroup().addTo(map);
  weatherOverlay = createWeatherOverlay(map, boundary, (date) => dayFormatter.format(new Date(date)));
  map.heatCanvas = heatCanvas;

  const labelPane = map.createPane('city-labels');
  labelPane.style.zIndex = 425;
  labelPane.style.pointerEvents = 'none';
  L.geoJSON(basemap, {
    filter: (feature) => feature.properties.style === 'city',
    pointToLayer: (feature, latlng) => {
      const { name, major } = feature.properties;
      const capital = name === 'Петропавловск';
      const label = element('span', name);
      return L.marker(latlng, {
        interactive: false, keyboard: false, pane: 'city-labels',
        icon: L.divIcon({ html: label, className: `geo-label ${capital ? 'capital' : major ? 'major' : 'minor'}`, iconSize: [0, 0] }),
      });
    },
  }).addTo(map);
  for (const [coordinates, name] of [[[56.5, 70.5], 'Россия'], [[51.55, 69.4], 'Казахстан']]) {
    L.marker(coordinates, {
      pane: 'city-labels', interactive: false, keyboard: false,
      icon: L.divIcon({ html: element('span', name), className: 'geo-region', iconSize: [0, 0] }),
    }).addTo(map);
  }
  L.control.scale({ metric: true, imperial: false, position: 'bottomright', maxWidth: 88 }).addTo(map);
  const reset = () => {
    world.remove();
    worldDetails.remove();
    map.setMinZoom(5);
    map.setMaxBounds([[47, 58], [60, 83]]);
    $('world-view').setAttribute('aria-pressed', 'false');
    $('world-view').textContent = 'Весь мир ↗';
    $('map-layer-status').hidden = true;
    map.fitBounds(region.getBounds(), { padding: [25, 24], animate: false });
  };
  $('world-view').addEventListener('click', () => {
    if (map.hasLayer(world)) {
      reset();
      return;
    }
    map.setMaxBounds(null);
    map.setMinZoom(0);
    world.addTo(map);
    setBasemap(true);
    map.fitBounds([[-62, -177], [72, 177]], { padding: [12, 12], animate: false });
    $('world-view').setAttribute('aria-pressed', 'true');
    $('world-view').textContent = 'Вернуться к СКО';
  });
  $('world-view').disabled = false;
  worldDetails.on('tileerror', () => {
    $('map-layer-status').textContent = 'Детальные плитки NASA GIBS недоступны. На карте показана обзорная подложка.';
    $('map-layer-status').hidden = false;
  });
  map.on('zoomend', () => {
    $('map').classList.toggle('detail-zoom', map.getZoom() >= 7.5);
    $('map').classList.toggle('world-scale', map.getZoom() < 4);
  });
  $('zoom-in').addEventListener('click', () => map.zoomIn());
  $('zoom-out').addEventListener('click', () => map.zoomOut());
  $('reset-map').addEventListener('click', reset);
  const section = $('observations');
  const expand = $('expand-map');
  const setExpanded = (active) => {
    section.classList.toggle('expanded-map', active);
    document.body.classList.toggle('atlas-expanded', active);
    expand.setAttribute('aria-pressed', String(active));
    expand.setAttribute('aria-label', active ? 'Свернуть карту' : 'Развернуть карту');
    expand.title = expand.getAttribute('aria-label');
    requestAnimationFrame(() => map.invalidateSize({ pan: true }));
  };
  expand.addEventListener('click', () => setExpanded(expand.getAttribute('aria-pressed') === 'false'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && section.classList.contains('expanded-map')) {
      setExpanded(false);
      expand.focus({ preventScroll: true });
    }
  });
  new ResizeObserver(() => map.invalidateSize({ pan: true })).observe($('map'));
  reset();
  addTerrainControl(map);
}

function mapStatus(message) {
  const node = $('map-message');
  node.textContent = message;
  node.hidden = !message;
}

function cellPopup(cell, count, period, sourceLabel, daily) {
  const [west, south, east, north] = cell;
  const body = element('div');
  body.append(element('strong', daily ? 'Тепловой сигнал за этот день' : `${number.format(count)} дн. с тепловым сигналом`), document.createElement('br'),
    element('span', `${period} · ${sourceLabel}`), document.createElement('br'),
    element('span', `${((south + north) / 2).toFixed(3)}° с. ш., ${((west + east) / 2).toFixed(3)}° в. д.`));
  return body;
}

function stopPlayback() {
  clearInterval(playbackTimer);
  playbackTimer = undefined;
  $('play-frames').replaceChildren(element('span', '▶'), document.createTextNode(' Воспроизвести'));
  $('play-frames').firstChild.setAttribute('aria-hidden', 'true');
}

function updateTimeline(data, date) {
  const slider = $('day-slider');
  slider.max = data.frames.length;
  slider.value = displayedDay ?? 0;
  slider.setAttribute('aria-valuetext', date ? dayFormatter.format(new Date(date)) : 'Весь месяц на карте');
  $('frame-date').textContent = date ? dayFormatter.format(new Date(date)) : 'Весь месяц';
  $('whole-month').disabled = displayedDay === null;
  for (const id of ['day-slider', 'play-frames']) $(id).disabled = false;
}

function renderTimelineOverview(data, row, platform) {
  const ticks = $('timeline-ticks');
  const counts = data.frames.map((frame) => frame && frame[platform].length);
  const largest = Math.max(0, ...counts);
  const peak = $('peak-day');
  peak.hidden = largest === 0;
  if (!peak.hidden) {
    const day = counts.indexOf(largest) + 1;
    const label = dayFormatter.format(new Date(frameDate(row.month, day)));
    peak.textContent = `Пик месяца: ${label} · ячеек с сигналом — ${number.format(largest)} ↗`;
    peak.dataset.day = day;
  }
  $('timeline-outages').hidden = !counts.includes(null);
  ticks.replaceChildren(...counts.map((count, index) => {
    const tick = element('i', undefined, count === null ? 'gap' : '');
    if (count) tick.style.setProperty('--activity', .3 + .7 * count / largest);
    if (index + 1 === displayedDay) tick.classList.add('current');
    return tick;
  }));
}

async function renderWeather(date, request) {
  const field = $('weather-field').value;
  const showWind = $('wind-layer').checked;
  if (!field && !showWind) return weatherOverlay.clear();
  if (!date) return weatherOverlay.clear('Выберите день на шкале, чтобы увидеть погоду.');
  try {
    weatherData ??= getJSON('data/weather.json?v=sko-layers');
    const data = await weatherData;
    if (request !== layerRequest) return;
    if (!data.days[date]) return weatherOverlay.clear('Архивная погода за этот день недоступна.');
    weatherOverlay.show(data, date, field, showWind);
  } catch (error) {
    weatherData = undefined;
    console.error(error);
    if (request === layerRequest) weatherOverlay.clear('Не удалось загрузить архивную погоду.');
  }
}

async function renderLayers() {
  const request = ++layerRequest;
  const month = calendar.months[monthIndex].month;
  const date = displayedDay === null ? null : frameDate(month, displayedDay);
  const [, events] = await Promise.all([renderWeather(date, request), renderExtraLayers?.(month, date)]);
  if (request !== layerRequest) return;
  const items = (events ?? []).filter(Boolean);
  const summary = $('visible-layer-summary');
  summary.replaceChildren(...items.map((item) => element('li', item)));
  summary.hidden = items.length === 0;
}

async function renderMap(row) {
  if (!mapAvailable) return;
  const request = ++mapRequest;
  const platform = monthSource(row);
  const sourceLabel = sources[platform];
  cellLayer.clearLayers();
  map.closePopup();
  $('map-subtitle').textContent = `Сетка 2 × 2 км · ${sourceLabel}`;
  const day = displayedDay;
  mapStatus('');
  try {
    if (!cachedCells.has(row.month)) cachedCells.set(row.month, getJSON(`data/${row.month}.json?v=sko-time`));
    const data = await cachedCells.get(row.month);
    if (request !== mapRequest) return;
    const date = day === null ? null : frameDate(row.month, day);
    const period = date ? dayFormatter.format(new Date(date)) : periodLabel(row.month);
    updateTimeline(data, date);
    renderTimelineOverview(data, row, platform);
    const fireVisible = $('fire-layer').checked;
    $('month-map-legend').hidden = day !== null || !fireVisible;
    $('day-map-legend').hidden = day === null || !fireVisible;
    if (!fireVisible) {
      $('map-summary').textContent = 'Слой тепловых точек выключен';
      return;
    }
    const frame = day === null ? undefined : data.frames[day - 1];
    if (frame === null) {
      $('map-summary').textContent = 'День исключён из анализа';
      mapStatus('Данные о горении за этот день исключены из-за сбоя спутниковых наблюдений.');
      return;
    }
    const cells = frame ? frame[platform].map((index) => data.cells[index]) : data.cells;
    let visible = 0;
    for (const cell of cells) {
      const count = day === null ? cell[4 + platform] : 1;
      if (!count) continue;
      visible++;
      const [west, south, east, north] = cell;
      const color = count < 3 ? '#ff9c57' : count < 7 ? '#ffc064' : '#eafe07';
      const shape = L.rectangle([[south, west], [north, east]], {
        renderer: map.heatCanvas, pane: 'activity-cells', color, weight: .7,
        opacity: 1, fillColor: color, fillOpacity: .85,
      });
      shape.bindPopup(() => cellPopup(cell, count, period, sourceLabel, day !== null));
      cellLayer.addLayer(shape);
    }
    $('map-summary').textContent = `Ячеек с сигналом — ${number.format(visible)}`;
    if (!visible) mapStatus('Нет зарегистрированных сигналов. Покрытие неизвестно.');
  } catch (error) {
    cachedCells.delete(row.month);
    if (request !== mapRequest) return;
    $('map-summary').textContent = 'Данные карты недоступны';
    $('frame-date').textContent = 'Данные недоступны';
    mapStatus('Не удалось загрузить ячейки этого месяца.');
    console.error(error);
  }
}

function showDay(day) {
  displayedDay = day;
  renderMap(calendar.months[monthIndex]);
  renderLayers();
}

function togglePlayback() {
  if (playbackTimer !== undefined) {
    stopPlayback();
    return;
  }
  const last = Number($('day-slider').max);
  showDay(displayedDay === null || displayedDay === last ? 1 : displayedDay);
  $('play-frames').textContent = 'Ⅱ Пауза';
  playbackTimer = setInterval(() => {
    if (displayedDay === last) stopPlayback();
    else showDay(displayedDay + 1);
  }, 650);
}

function valueFor(row) {
  const platform = monthSource(row);
  return row.raw[platform] * calendar.factors[platform];
}

function difference(row, value) {
  return row.norm > 0 ? (value - row.norm) / row.norm : null;
}

function renderComparison(row) {
  const platform = monthSource(row);
  const value = valueFor(row);
  const delta = difference(row, value);
  const gap = value - row.norm;
  const direction = gap > 0 ? 'выше' : 'ниже';
  const scale = Math.max(value, row.norm, 1);
  const deviation = $('deviation');
  deviation.className = `deviation ${value === 0 || gap === 0 ? 'neutral' : gap < 0 ? 'below' : ''}`;
  deviation.textContent = value === 0 ? 'Спутник не зарегистрировал сигналов'
    : Math.abs(delta ?? 1) < .005 ? 'Активность на уровне нормы'
      : delta === null ? 'Активность выше нулевой нормы'
        : `Активность на ${unsignedPercent.format(Math.abs(delta))} ${direction} нормы`;
  $('actual-bar-value').textContent = number.format(value);
  $('norm-bar-value').textContent = number.format(row.norm);
  $('actual-bar').style.width = `${100 * value / scale}%`;
  $('norm-bar').style.width = `${100 * row.norm / scale}%`;
  $('bar-chart').setAttribute('aria-label', `Активность: ${number.format(value)}. Историческая норма: ${number.format(row.norm)}.`);
  $('period-source').textContent = `${sources[platform]} · NASA FIRMS`;
  $('source-explanation').textContent = platform === 0
    ? 'Месячное значение по наблюдениям Aqua.'
    : 'Месячное значение пересчитано в шкалу Aqua. На карте — наблюдения VIIRS.';
  const aquaDelta = difference(row, row.raw[0]);
  const referenceCheck = $('reference-check');
  referenceCheck.hidden = !platform || delta === null
    || delta * aquaDelta >= 0 || Math.min(Math.abs(delta), Math.abs(aquaDelta)) < .005;
  if (!referenceCheck.hidden) {
    const aquaDirection = aquaDelta > 0 ? 'выше' : 'ниже';
    referenceCheck.textContent = `Aqua за тот же месяц показывает ${unsignedPercent.format(Math.abs(aquaDelta))} ${aquaDirection} нормы. Вывод зависит от спутника.`;
  }
  $('coverage-title').textContent = `Учтено ${row.days} из ${row.days + row.excluded} дней`;
  $('coverage-description').textContent = row.excluded
    ? `Пропущены дни с известными сбоями (${row.excluded}). Облачность и покрытие не проверены.`
    : 'Облачность и покрытие спутника не проверены.';
  $('comparison-period').textContent = periodLabel(row.month);
}

function cellAppearance(row) {
  const value = valueFor(row);
  const delta = difference(row, value);
  if (mode === 'deviation') {
    let level = 'near-norm';
    if (delta === null) level = 'no-norm';
    else if (delta <= -.5) level = 'below-2';
    else if (delta < -.1) level = 'below-1';
    else if (delta >= .5) level = 'above-2';
    else if (delta > .1) level = 'above-1';
    return [level, delta === null ? '—' : percent.format(delta).replace(/\s(?=%)/, '')];
  }
  const level = value === 0 ? 0 : [10, 50, 150, 400].filter((threshold) => value >= threshold).length + 1;
  return [`activity-${level}`, number.format(value)];
}

function renderCalendarInsight() {
  const peaks = new Map();
  for (const row of calendar.months) {
    const year = row.month.slice(0, 4);
    const value = valueFor(row);
    const month = row.month.slice(5);
    const peak = peaks.get(year);
    if (!peak || value > peak.value) peaks.set(year, { value, months: [month] });
    else if (value === peak.value) peak.months.push(month);
  }
  const topMonths = new Set([...peaks.values()].flatMap((peak) => peak.months));
  const insight = $('calendar-insight');
  insight.hidden = topMonths.size !== 1 || peaks.size < 2;
  if (!insight.hidden) {
    const month = fullMonths[Number([...topMonths][0]) - 1];
    insight.textContent = `${month[0].toUpperCase() + month.slice(1)} — месяц с самой высокой активностью во всех ${peaks.size} сезонах.`;
  }
}

function makeCalendar() {
  const table = $('calendar');
  const header = table.createTHead().insertRow();
  for (const [month, name] of ['Год', ...monthNames].entries()) {
    const th = element('th', name);
    th.scope = 'col';
    if (month && (month < 4 || month > 10)) th.className = 'off-season';
    header.append(th);
  }
  const body = table.createTBody();
  const indices = new Map(calendar.months.map((row, index) => [row.month, index]));
  const years = [...new Set(calendar.months.map((row) => row.month.slice(0, 4)))];
  for (const year of years) {
    const tr = body.insertRow();
    const th = element('th', year);
    th.scope = 'row';
    tr.append(th);
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      const td = tr.insertCell();
      const index = indices.get(key);
      if (index === undefined) {
        td.className = 'unavailable off-season';
        td.title = 'Вне сезона';
        td.setAttribute('aria-label', 'Вне сезона');
        continue;
      }
      const button = element('button');
      button.type = 'button';
      button.dataset.index = index;
      button.addEventListener('click', () => chooseMonth(index));
      td.append(button);
    }
  }
}

function renderCalendar() {
  for (const button of $('calendar').querySelectorAll('button')) {
    const index = Number(button.dataset.index);
    const row = calendar.months[index];
    const [className, label] = cellAppearance(row);
    const platform = monthSource(row);
    const summary = `${periodLabel(row.month)}, ${sources[platform]}, ${number.format(valueFor(row))} ячейко-дней, норма ${number.format(row.norm)}`;
    button.className = className;
    button.replaceChildren(element('span', label), element('span', sourceTags[platform], 'calendar-source'));
    button.title = summary;
    button.setAttribute('aria-label', summary);
    if (index === monthIndex) button.setAttribute('aria-current', 'date');
    else button.removeAttribute('aria-current');
  }
  $('activity-view').setAttribute('aria-pressed', String(mode === 'activity'));
  $('deviation-view').setAttribute('aria-pressed', String(mode === 'deviation'));
  renderCalendarInsight();
  $('calendar-key').replaceChildren(...(mode === 'activity' ? activityKey : deviationKey).map(([level, label]) => {
    const item = element('span');
    const swatch = element('i', undefined, level);
    swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, document.createTextNode(label));
    return item;
  }));
}

function chooseMonth(index) {
  const row = calendar.months[index];
  if (!row) return;
  if (displayedMonth !== row.month) {
    stopPlayback();
    displayedMonth = row.month;
    displayedDay = displayedDay === null ? null : 1;
    for (const id of ['day-slider', 'play-frames', 'whole-month']) $(id).disabled = true;
    $('frame-date').textContent = 'Загрузка…';
    $('map-summary').textContent = 'Загрузка ячеек…';
    $('timeline-ticks').replaceChildren();
    $('peak-day').hidden = true;
    $('timeline-outages').hidden = true;
  }
  monthIndex = index;
  $('period').value = String(index);
  $('previous').disabled = index === 0;
  $('next').disabled = index === calendar.months.length - 1;
  $('calendar-selection').textContent = `${periodLabel(row.month)} на карте ↑`;
  renderCalendar();
  renderComparison(row);
  if (mapAvailable) renderLayers();
  return renderMap(row);
}

async function start() {
  $('open-method').addEventListener('click', () => $('method').showModal());
  try {
    calendar = await getJSON('data/calendar.json?v=sko-series');
  } catch (error) {
    $('app-status').textContent = 'Не удалось загрузить календарь. Откройте приложение через локальный веб-сервер.';
    $('overview').hidden = true;
    document.querySelector('.calendar-panel').hidden = true;
    console.error(error);
    return;
  }
  try {
    const [basemap, boundary] = await Promise.all([getJSON('data/basemap.geojson'), getJSON('data/region.geojson')]);
    createMap(basemap, boundary);
    mapAvailable = true;
    $('fire-layer').disabled = false;
    $('local-layers').disabled = false;
    const extraControls = $('extra-layer-controls');
    extraControls.addEventListener('layer-tile-error', ({ detail }) => {
      $('map-layer-status').textContent = `${detail} · часть спутниковых плиток недоступна.`;
      $('map-layer-status').hidden = false;
    });
    createExtraLayers(map, extraControls, getJSON, (startDay) => {
      if (startDay && displayedDay === null) showDay(1);
      else renderLayers();
    })
      .then((render) => { renderExtraLayers = render; if (monthIndex !== undefined) renderLayers(); })
      .catch((error) => {
        $('map-layer-status').textContent = 'Не удалось загрузить каталог дополнительных слоёв.';
        $('map-layer-status').hidden = false;
        console.error(error);
      });
  } catch (error) {
    mapStatus('Не удалось загрузить основу карты.');
    for (const button of document.querySelectorAll('.map-tools button')) button.disabled = true;
    console.error(error);
  }
  for (const [index, row] of calendar.months.entries()) {
    const option = element('option', periodLabel(row.month));
    option.value = index;
    $('period').append(option);
  }
  makeCalendar();
  for (const id of ['source', 'period', 'activity-view', 'deviation-view']) $(id).disabled = false;
  $('source').addEventListener('change', (event) => {
    source = event.target.value;
    chooseMonth(monthIndex);
  });
  $('period').addEventListener('change', (event) => chooseMonth(Number(event.target.value)));
  $('previous').addEventListener('click', () => chooseMonth(monthIndex - 1));
  $('next').addEventListener('click', () => chooseMonth(monthIndex + 1));
  $('play-frames').addEventListener('click', togglePlayback);
  $('day-slider').addEventListener('input', (event) => {
    stopPlayback();
    const day = Number(event.target.value);
    showDay(day || null);
  });
  $('whole-month').addEventListener('click', () => {
    stopPlayback();
    showDay(null);
  });
  $('peak-day').addEventListener('click', (event) => {
    stopPlayback();
    showDay(Number(event.currentTarget.dataset.day));
  });
  $('fire-layer').addEventListener('change', () => renderMap(calendar.months[monthIndex]));
  $('local-layers').addEventListener('change', () => {
    if (displayedDay === null && ($('weather-field').value || $('wind-layer').checked)) showDay(1);
    else renderLayers();
  });
  $('activity-view').addEventListener('click', () => { mode = 'activity'; renderCalendar(); });
  $('deviation-view').addEventListener('click', () => { mode = 'deviation'; renderCalendar(); });
  const caseMonth = calendar.months.findIndex((row) => row.month === '2025-04');
  const caseButton = $('case-atlas');
  if (mapAvailable && caseMonth >= 0) {
    caseButton.hidden = false;
    caseButton.addEventListener('click', async () => {
      stopPlayback();
      if ($('world-view').getAttribute('aria-pressed') === 'true') $('reset-map').click();
      source = '2';
      $('source').value = source;
      $('fire-layer').checked = true;
      await chooseMonth(caseMonth);
      showDay(12);
      map.fitBounds([[53.035, 71.68], [53.346, 72.013]], { padding: [22, 22], animate: false });
      $('observations').scrollIntoView();
    });
  }
  $('app-status').hidden = true;
  const initial = calendar.months.findIndex((row) => row.month === '2025-04');
  await chooseMonth(initial < 0 ? 0 : initial);
}

start();
