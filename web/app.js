'use strict';

const $ = (id) => document.getElementById(id);
const sources = ['Aqua / MODIS', 'Suomi NPP / VIIRS', 'NOAA-20 / VIIRS'];
const monthNames = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const fullMonths = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });
const unsignedPercent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 0 });
const activityKey = [['activity-0', '0'], ['activity-1', 'до 10'], ['activity-2', '10–49'], ['activity-3', '50–149'], ['activity-4', '150–399'], ['activity-5', '400+']];
const deviationKey = [['below-2', '≤ −50%'], ['below-1', '−50…−10%'], ['near-norm', 'около нормы'], ['above-1', '+10…+50%'], ['above-2', '≥ +50%']];

let calendar;
let map;
let region;
let cellLayer;
let monthIndex;
let source = 0;
let mode = 'activity';
let mapRequest = 0;
let mapAvailable;
const cachedCells = new Map();

function periodLabel(key) {
  const [year, month] = key.split('-');
  return `${fullMonths[Number(month) - 1]} ${year}`;
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

function createMap(basemap, boundary) {
  const styles = {
    country: { color: '#73818a', weight: 1.45, fillColor: '#202b33', fillOpacity: 1 },
    province: { color: '#52606b', weight: .65, opacity: .75, dashArray: '3 3' },
    road: { color: '#586169', weight: .65, opacity: .64 },
    lake: { color: '#416272', weight: .8, fillColor: '#243f50', fillOpacity: 1 },
    river: { color: '#4e7788', weight: 1.05, opacity: .88 },
  };
  map = L.map('map', {
    zoomControl: false, minZoom: 5, maxZoom: 12, zoomSnap: .25,
    maxBounds: [[47, 58], [60, 83]], maxBoundsViscosity: .8, zoomAnimation: false,
  });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('<a href="https://www.naturalearthdata.com/">Natural Earth</a> · <a href="https://www.geoboundaries.org/">geoBoundaries</a>');
  L.geoJSON(basemap, {
    filter: (feature) => feature.properties.style !== 'city',
    style: (feature) => {
      const style = styles[feature.properties.style];
      return feature.properties.country === 'RUS' ? { ...style, fillColor: '#26313a' } : style;
    },
    interactive: false,
  }).addTo(map);

  region = L.geoJSON(boundary, { interactive: false, style: {
    color: '#87abb9', weight: 1.4, opacity: .9, fillColor: '#3b6576', fillOpacity: .19, dashArray: '4 3',
  } }).addTo(map);
  const activityPane = map.createPane('activity-cells');
  activityPane.style.zIndex = 415;
  const heatCanvas = L.canvas({ padding: .5, pane: 'activity-cells' });
  cellLayer = L.featureGroup().addTo(map);
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
  const reset = () => map.fitBounds(region.getBounds(), { padding: [25, 24], animate: false });
  map.on('zoomend', () => $('map').classList.toggle('detail-zoom', map.getZoom() >= 7.5));
  $('zoom-in').addEventListener('click', () => map.zoomIn());
  $('zoom-out').addEventListener('click', () => map.zoomOut());
  $('reset-map').addEventListener('click', reset);
  reset();
}

function mapStatus(message) {
  const node = $('map-message');
  node.textContent = message;
  node.hidden = !message;
}

function cellPopup(cell, count, row, sourceLabel) {
  const [west, south, east, north] = cell;
  const body = element('div');
  body.append(element('strong', `${number.format(count)} дн. с детекциями`), document.createElement('br'),
    element('span', `${periodLabel(row.month)} · ${sourceLabel}`), document.createElement('br'),
    element('span', `${((south + north) / 2).toFixed(3)}° с. ш., ${((west + east) / 2).toFixed(3)}° в. д.`));
  return body;
}

async function renderMap(row) {
  if (!mapAvailable) return;
  const request = ++mapRequest;
  const platform = source;
  const sourceLabel = sources[platform];
  cellLayer.clearLayers();
  map.closePopup();
  $('map-subtitle').textContent = `Сетка 2 × 2 км · ${sourceLabel}`;
  $('map-summary').textContent = 'Загрузка ячеек…';
  mapStatus('');
  try {
    if (!cachedCells.has(row.month)) {
      cachedCells.set(row.month, await getJSON(`data/${row.month}.json`));
    }
    if (request !== mapRequest) return;
    let visible = 0;
    for (const cell of cachedCells.get(row.month)) {
      const count = cell[4 + platform];
      if (!count) continue;
      visible++;
      const [west, south, east, north] = cell;
      const color = count < 3 ? '#cf813f' : count < 7 ? '#ff9d54' : '#ffe2a4';
      const shape = L.rectangle([[south, west], [north, east]], {
        renderer: map.heatCanvas, pane: 'activity-cells', color, weight: .7,
        opacity: .9, fillColor: color, fillOpacity: .82,
      });
      shape.bindPopup(() => cellPopup(cell, count, row, sourceLabel));
      cellLayer.addLayer(shape);
    }
    $('map-summary').textContent = `${number.format(visible)} ячеек · ${number.format(row.points[platform])} исходных детекций`;
    if (!visible) mapStatus('Детекций нет. Покрытие неизвестно.');
  } catch (error) {
    if (request !== mapRequest) return;
    $('map-summary').textContent = 'Данные карты недоступны';
    mapStatus('Не удалось загрузить ячейки этого месяца.');
    console.error(error);
  }
}

function valueFor(row) {
  return row.raw[source] * calendar.factors[source];
}

function difference(row, value) {
  return row.norm > 0 ? (value - row.norm) / row.norm : null;
}

function renderComparison(row) {
  const value = valueFor(row);
  const delta = difference(row, value);
  const gap = value - row.norm;
  const direction = gap > 0 ? 'выше' : 'ниже';
  const scale = Math.max(value, row.norm, 1);
  $('activity-value').textContent = number.format(value);
  $('metric-scale').textContent = source ? 'в шкале Aqua' : 'Aqua';
  const deviation = $('deviation');
  deviation.className = `deviation ${gap < 0 ? 'below' : gap === 0 ? 'neutral' : ''}`;
  deviation.textContent = gap === 0 ? 'На уровне нормы'
    : delta === null ? `${number.format(gap)} ячейко-дней выше нулевой нормы`
      : `${unsignedPercent.format(Math.abs(delta))} ${direction} нормы`;
  $('actual-bar-value').textContent = number.format(value);
  $('norm-bar-value').textContent = number.format(row.norm);
  $('actual-bar').style.width = `${100 * value / scale}%`;
  $('norm-bar').style.width = `${100 * row.norm / scale}%`;
  $('bar-chart').setAttribute('aria-label', `Активность: ${number.format(value)}. Историческая норма: ${number.format(row.norm)}.`);
  $('coverage-title').textContent = `Учтено ${row.days} из ${row.days + row.excluded} дней`;
  $('coverage-description').textContent = row.excluded
    ? `Исключено дней со сбоями: ${row.excluded}. Локальное покрытие неизвестно.`
    : 'Локальное покрытие неизвестно.';
  const badge = $('period-badge');
  badge.hidden = false;
  badge.textContent = row.split === 'test' ? 'Проверка' : 'Базовый период';
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
    return [level, delta === null ? '—' : percent.format(delta)];
  }
  const level = value === 0 ? 0 : [10, 50, 150, 400].filter((threshold) => value >= threshold).length + 1;
  return [`activity-${level}`, number.format(value)];
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
    const summary = `${periodLabel(row.month)}, ${number.format(valueFor(row))} ячейко-дней, норма ${number.format(row.norm)}`;
    button.className = className;
    button.textContent = label;
    button.title = summary;
    button.setAttribute('aria-label', summary);
    if (index === monthIndex) button.setAttribute('aria-current', 'date');
    else button.removeAttribute('aria-current');
  }
  $('activity-view').setAttribute('aria-pressed', String(mode === 'activity'));
  $('deviation-view').setAttribute('aria-pressed', String(mode === 'deviation'));
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
  monthIndex = index;
  $('period').value = String(index);
  $('previous').disabled = index === 0;
  $('next').disabled = index === calendar.months.length - 1;
  renderCalendar();
  renderComparison(row);
  return renderMap(row);
}

async function start() {
  $('open-method').addEventListener('click', () => $('method').showModal());
  try {
    calendar = await getJSON('data/calendar.json');
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
    source = Number(event.target.value);
    chooseMonth(monthIndex);
  });
  $('period').addEventListener('change', (event) => chooseMonth(Number(event.target.value)));
  $('previous').addEventListener('click', () => chooseMonth(monthIndex - 1));
  $('next').addEventListener('click', () => chooseMonth(monthIndex + 1));
  $('activity-view').addEventListener('click', () => { mode = 'activity'; renderCalendar(); });
  $('deviation-view').addEventListener('click', () => { mode = 'deviation'; renderCalendar(); });
  $('app-status').hidden = true;
  const initial = calendar.months.findIndex((row) => row.month === '2025-04');
  await chooseMonth(initial < 0 ? 0 : initial);
}

start();
