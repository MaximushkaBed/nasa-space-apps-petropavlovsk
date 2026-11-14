'use strict';

import { createExtraLayers } from './map-layers.js?v=weather-motion';
import { createWorldWind } from './world-wind.js?v=weather-motion';
import { createWeatherOverlay } from './weather-overlay.js?v=sko-atlas';
import { createFireOverlay, fireDetailZoom } from './fire-overlay.js?v=fire-contrast';
import { createFireViewport } from './fire-viewport.js?v=fire-detail';
import { createAreaAnalysis, inRing } from './area-analysis.js?v=fire-detail';
import { addDays, createPeriodPicker, daysBetween } from './period-picker.js?v=atlas-periods';

const $ = (id) => document.getElementById(id);
const sources = ['Aqua / MODIS', 'Suomi NPP / VIIRS', 'NOAA-20 / VIIRS'];
const sourceTags = ['MODIS', 'Suomi', 'NOAA‑20'];
const detailedImageryMinZoom = 6;
const atlasMaxZoom = 17;
const mercatorLimit = 85.0511287798;
const kishkenekolDay = '2025-04-12';
const monthNames = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const fullMonths = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });
const unsignedPercent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 0 });
const activityKey = [['activity-0', '0'], ['activity-1', 'до 10'], ['activity-2', '10–49'], ['activity-3', '50–149'], ['activity-4', '150–399'], ['activity-5', '400+']];
const deviationKey = [['below-2', '−50% и ниже'], ['below-1', 'ниже нормы'], ['near-norm', 'в пределах ±10%'], ['above-1', 'выше нормы'], ['above-2', '+50% и выше']];

let calendar;
let map;
let weatherOverlay;
let worldWind;
let fireOverlay;
let fireViewport;
let viewportFrame;
let areaAnalysis;
let fireDisplay = 'points';
let worldArchive;
let worldFrame;
let worldRequest;
let pendingFrame;
let activePeriod;
let inspectionPeriod;
let dailySatellite = '';
let playbackTimer;
let layerRequest = 0;
let renderExtraLayers;
let weatherData;
let monthIndex;
let source = 'unified';
let mode = 'deviation';
const cachedCells = new Map();
const noFirePoints = [];

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
    pane: 'terrain-shading', maxNativeZoom: 12, maxZoom: map.getMaxZoom(),
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

function createWorldOverview() {
  const Overview = L.GridLayer.extend({
    createTile({ x, y, z }) {
      const tile = L.DomUtil.create('div', 'blue-marble-tile');
      const size = 256 * 2 ** z;
      tile.style.backgroundSize = `${size}px ${size}px`;
      tile.style.backgroundPosition = `${-x * 256}px ${-y * 256}px`;
      return tile;
    },
  });
  return new Overview({
    maxNativeZoom: 2, maxZoom: atlasMaxZoom, zIndex: 1,
    attribution: '<a href="https://nasa-gibs.github.io/gibs-api-docs/">Blue Marble · NASA GIBS</a>',
  });
}

function createMap(basemap, boundary, closePanel) {
  const styles = {
    country: { color: '#7890a0', weight: 1.1, fillColor: '#162846', fillOpacity: 1 },
    province: { color: '#74838e', weight: .65, opacity: .58, dashArray: '3 4' },
    road: { color: '#84959f', weight: .6, opacity: .37 },
    lake: { color: '#6098b1', weight: .75, fillColor: '#193c58', fillOpacity: 1 },
    river: { color: '#6498af', weight: .85, opacity: .67 },
  };
  map = L.map('map', {
    zoomControl: false, maxZoom: atlasMaxZoom, zoomSnap: .25, worldCopyJump: true,
    maxBounds: [[-mercatorLimit, -1000000], [mercatorLimit, 1000000]], maxBoundsViscosity: 1,
    inertia: false, zoomAnimation: false,
  });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('<a href="https://www.naturalearthdata.com/">Natural Earth</a> · <a href="https://www.geoboundaries.org/">geoBoundaries</a>');
  createWorldOverview().addTo(map);
  const worldDetails = L.tileLayer('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg', {
    minZoom: 3, maxNativeZoom: 8, maxZoom: atlasMaxZoom, zIndex: 2,
  });
  const detailedImagery = L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false', {
    className: 'esri-imagery', minZoom: detailedImageryMinZoom, maxZoom: atlasMaxZoom,
    zIndex: 3,
    attribution: '<a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Esri World Imagery</a> · Vantor, Earthstar Geographics, GIS User Community',
  });
  const imageryStatus = $('imagery-status');
  let satelliteView = true;
  detailedImagery.on('loading', () => { imageryStatus.hidden = true; });
  detailedImagery.on('tileerror', () => { imageryStatus.hidden = false; });
  const updateDetailedImagery = () => {
    if (satelliteView && map.getZoom() >= detailedImageryMinZoom) detailedImagery.addTo(map);
    else {
      detailedImagery.remove();
      imageryStatus.hidden = true;
    }
  };
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

  const regionPane = map.createPane('selected-region');
  regionPane.style.zIndex = 404;
  regionPane.style.pointerEvents = 'none';
  const makeRegion = (offset) => L.geoJSON(boundary, {
    pane: 'selected-region', interactive: false,
    coordsToLatLng: ([lon, lat]) => L.latLng(lat, lon + offset),
    style: { color: '#9ae8ff', weight: 2, fillOpacity: .04, dashArray: '5 4' },
  }).addTo(map);
  const region = makeRegion(0);
  const regionalBounds = region.getBounds();
  const center = regionalBounds.getCenter();
  for (const offset of [-360, 0, 360]) {
    if (offset) makeRegion(offset);
    L.marker([center.lat, center.lng + offset], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'region-badge', html: 'СКО', iconSize: [32, 19], iconAnchor: [-7, 22] }),
    }).addTo(map);
  }
  const { type, coordinates } = boundary.geometry;
  const polygons = type === 'Polygon' ? [coordinates] : coordinates;
  const west = regionalBounds.getWest(), east = regionalBounds.getEast();
  const south = regionalBounds.getSouth(), north = regionalBounds.getNorth();
  const withinRegion = (lon, lat) => lon >= west && lon <= east && lat >= south && lat <= north
    && polygons.some(([outer, ...holes]) => inRing(outer, lon, lat) && !holes.some((hole) => inRing(hole, lon, lat)));
  const setBasemap = (useSatellite) => {
    satelliteView = useSatellite;
    if (useSatellite) worldDetails.addTo(map);
    else worldDetails.remove();
    geography.eachLayer((layer) => {
      const style = layer.feature.properties.style;
      if (style === 'country' || style === 'lake') layer.setStyle({ fillOpacity: useSatellite ? 0 : 1 });
    });
    $('satellite-view').setAttribute('aria-pressed', String(useSatellite));
    $('vector-view').setAttribute('aria-pressed', String(!useSatellite));
    updateDetailedImagery();
  };
  $('satellite-view').addEventListener('click', () => setBasemap(true));
  $('vector-view').addEventListener('click', () => setBasemap(false));
  $('satellite-view').disabled = false;
  $('vector-view').disabled = false;
  setBasemap(true);
  const activityPane = map.createPane('activity-cells');
  activityPane.style.zIndex = 415;
  fireOverlay = createFireOverlay(map, () => worldArchive?.platforms ?? [], number, withinRegion, () => !areaAnalysis.drawing());
  fireViewport = createFireViewport(map, fireDetailZoom, (frame) => {
    if (frame === viewportFrame) return;
    viewportFrame = frame;
    map.closePopup();
    renderFireLayer();
    renderAreaFrame();
  });
  areaAnalysis = createAreaAnalysis(map, () => { map.closePopup(); closePanel(); }, getJSON, boundary.geometry);
  weatherOverlay = createWeatherOverlay(map, boundary, (date) => dayFormatter.format(new Date(date)));
  worldWind = createWorldWind(map, $('world-wind-status'));

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
    map.fitBounds(regionalBounds, { padding: [30, Math.min(180, map.getSize().y * .23)], animate: false });
  };
  const showWorld = () => {
    map.setView([22, 0], map.getMinZoom(), { animate: false });
  };
  const fitViewport = () => {
    map.invalidateSize({ pan: false });
    // At the minimum zoom the Mercator world must be at least as tall as the map.
    map.setMinZoom(Math.max(0, Math.ceil(Math.log2(Math.max(1, map.getSize().y) / 256) * 4) / 4));
  };
  $('world-view').addEventListener('click', showWorld);
  $('world-view').disabled = false;
  worldDetails.on('tileerror', () => {
    $('map-layer-status').textContent = 'Детальные плитки NASA GIBS недоступны. На карте показана обзорная подложка.';
    $('map-layer-status').hidden = false;
  });
  map.on('zoomend', () => {
    $('map').classList.toggle('detail-zoom', map.getZoom() >= 7.5);
    $('map').classList.toggle('world-scale', map.getZoom() < 4);
    updateDetailedImagery();
  });
  $('zoom-in').addEventListener('click', () => map.zoomIn());
  $('zoom-out').addEventListener('click', () => map.zoomOut());
  $('reset-map').addEventListener('click', reset);
  $('reset-map').disabled = false;
  fitViewport();
  showWorld();
  new ResizeObserver(fitViewport).observe($('map'));
  addTerrainControl(map);
  return reset;
}

function mapStatus(message) {
  const node = $('map-message');
  node.textContent = message;
  node.hidden = !message;
}

function stopPlayback() {
  clearTimeout(playbackTimer);
  playbackTimer = undefined;
  $('play-frames').replaceChildren(element('span', '▶'), document.createTextNode(' Воспроизвести'));
  $('play-frames').firstChild.setAttribute('aria-hidden', 'true');
  $('play-weather').setAttribute('aria-pressed', 'false');
  $('play-weather').textContent = '▶ Погода';
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

async function renderLayers(day = $('world-date').value) {
  const request = ++layerRequest;
  const date = typeof day === 'string' ? day : $('world-date').value;
  if (!date) return;
  const month = date.slice(0, 7);
  const status = $('map-layer-status');
  status.hidden = true;
  status.textContent = '';
  const [, events] = await Promise.all([renderWeather(date, request), renderExtraLayers?.(month, date),
    worldWind.show($('world-wind-flow').checked ? date : undefined)]);
  if (request !== layerRequest) return;
  const items = (events ?? []).filter(Boolean);
  if (activePeriod?.start !== activePeriod?.end && items.length) items.unshift(`Дата спутниковых слоёв и погоды · ${date} UTC`);
  const summary = $('visible-layer-summary');
  summary.replaceChildren(...items.map((item) => element('li', item)));
  summary.hidden = items.length === 0;
}

function firePoints() {
  const points = worldFrame?.points ?? noFirePoints;
  const satellite = $('world-satellite').value;
  if (satellite === '' || worldFrame?.approximate) return points;
  return points.filter((point) => point[2] === Number(satellite));
}

function renderFireLayer(points = firePoints()) {
  const visible = $('fire-layer').checked;
  const grouped = Boolean(activePeriod && activePeriod.start !== activePeriod.end);
  const detail = viewportFrame?.status === 'ok' ? viewportFrame.points : undefined;
  const waitingForDetail = grouped && !detail && map.getZoom() >= fireDetailZoom;
  $('heat-legend').hidden = !visible || fireDisplay !== 'heat' || waitingForDetail;
  $('heat-legend').lastChild.textContent = grouped && !detail ? ' Плотность по сводке' : ' Плотность детекций';
  $('world-point-legend').hidden = !visible || fireDisplay !== 'points' || waitingForDetail;
  $('world-point-legend').classList.toggle('grouped', grouped && !detail);
  $('world-point-legend').lastChild.textContent = grouped && !detail ? ' Группы детекций' : ' Пиксели MODIS / VIIRS';
  const status = viewportFrame?.status;
  const coverage = viewportFrame?.missing?.length ? ' В архиве есть пропуски дат.' : '';
  const message = status === 'ok' ? `${detail.length ? (viewportFrame.method === 'archive' ? 'Исходный архив · без фильтра качества.' : '')
    : 'В архиве для этого участка нет детекций.'}${coverage}`.trim() : {
    loading: 'Загружаем отдельные детекции…',
    too_wide: 'Приблизьте карту, чтобы увидеть отдельные детекции.',
    too_dense: 'Слишком много детекций. Приблизьте карту или сократите период.',
    too_slow: viewportFrame?.reason === 'busy' ? 'Сервер ещё загружает предыдущий участок. Повторите запрос.'
      : 'Область загружается долго. Приблизьте карту или сократите период.',
    unavailable: 'Исходные детекции за этот период недоступны.',
    error: 'Детекции на этом участке не загрузились.',
  }[status];
  $('fire-detail-status').textContent = visible && grouped ? message ?? '' : '';
  $('fire-detail-status').hidden = !visible || !grouped || !message;
  $('fire-detail-retry').hidden = !visible || !grouped || !['error', 'too_slow'].includes(status);
  return fireOverlay(points, fireDisplay, visible, grouped, detail);
}

function updateFireViewport() {
  const satellite = $('world-satellite').value;
  const visible = $('fire-layer').checked;
  const span = activePeriod;
  fireViewport.select(visible && span && span.start !== span.end ? {
    start: span.start, end: span.end, satellite,
    maxWidth: worldArchive.viewportMaxWidth ?? 20, maxHeight: worldArchive.viewportMaxHeight ?? 15,
    key: `${span.start}/${span.end}/${satellite}`,
  } : undefined);
}

function renderAreaFrame(points = firePoints(), failed = false) {
  const approximate = Boolean(worldFrame?.approximate);
  const date = activePeriod?.start === activePeriod?.end ? $('world-date').value : $('frame-date').textContent;
  areaAnalysis.render({ date, points: worldFrame ? points : undefined, failed,
    platforms: worldArchive.platforms, approximate, cellDegrees: worldFrame?.cellDegrees,
    regionalByPlatform: worldFrame?.regionalByPlatform, regionalExact: worldFrame?.regionalExact, viewport: viewportFrame });
}

function showWorldFrame() {
  mapStatus('');
  const visible = $('fire-layer').checked;
  const selectedPoints = firePoints();
  const approximate = Boolean(worldFrame?.approximate);
  const drawnRegionalCount = renderFireLayer(selectedPoints);
  const regionalCount = worldFrame?.regionalCount ?? drawnRegionalCount;
  renderAreaFrame(selectedPoints);
  $('map-summary').textContent = !visible ? 'Слой выключен'
    : worldFrame ? `Мир · ${number.format(worldFrame.total ?? selectedPoints.length)} детекций` : 'Загрузка детекций…';
  const regionalPrefix = approximate && !worldFrame.regionalExact ? '≈ ' : '';
  $('regional-count').textContent = visible && worldFrame ? `СКО · ${regionalPrefix}${number.format(regionalCount)}` : '';
  $('sko-example').hidden = !visible || !worldFrame || regionalCount > 0 || approximate
    || kishkenekolDay < worldArchive.first || kishkenekolDay > worldArchive.last;
  if (worldFrame?.method === 'publisher') {
    const through = worldFrame.coveredEnd;
    const missing = worldFrame.missing?.reduce((days, gap) => days + 1 + daysBetween(gap.start, gap.end), 0) ?? 0;
    $('archive-caption').textContent = `Архивные сводки без фильтра качества${through ? ` · до ${shortDate.format(new Date(through))}` : ''}${missing ? ` · пропусков: ${missing} дн.` : ''}`;
  }
  if (visible && worldFrame && (worldFrame.total ?? selectedPoints.length) === 0) {
    mapStatus('За выбранное время нет записей выбранных спутников. Покрытие неизвестно.');
  }
}

async function loadWorldFrame() {
  if (!worldArchive || !activePeriod) return;
  const { start, end } = activePeriod;
  const range = start !== end;
  const params = new URLSearchParams({ start, end });
  const satellite = $('world-satellite').value;
  if (satellite !== '') params.set('satellite', satellite);
  const path = range ? `/api/fires/period?${params}` : `/api/fires/${start}`;
  if (worldFrame?.path === path) {
    updateFireViewport();
    showWorldFrame();
    return;
  }
  if (pendingFrame === path) {
    updateFireViewport();
    renderFireLayer();
    return;
  }
  worldRequest?.abort();
  const request = new AbortController();
  worldRequest = request;
  pendingFrame = path;
  worldFrame = undefined;
  updateFireViewport();
  showWorldFrame();
  try {
    const response = await fetch(path, { signal: request.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const frame = await response.json();
    if (request.signal.aborted) return;
    worldFrame = { ...frame, path };
    showWorldFrame();
  } catch (error) {
    if (request.signal.aborted) return;
    renderAreaFrame(undefined, true);
    $('regional-count').textContent = '';
    $('sko-example').hidden = true;
    $('map-summary').textContent = 'Данные мира недоступны';
    mapStatus(range ? 'Не удалось загрузить сводку. Повторите попытку или выберите меньший период.'
      : 'Мировые детекции за этот день не загрузились. Выберите другую дату или повторите попытку.');
  } finally {
    if (worldRequest === request) pendingFrame = undefined;
  }
}

const shortDate = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

function sliderRange(day) {
  if (inspectionPeriod) return [inspectionPeriod.start, inspectionPeriod.end];
  const month = day.slice(0, 7);
  const first = month === worldArchive.first.slice(0, 7) ? worldArchive.first : `${month}-01`;
  const last = month === worldArchive.last.slice(0, 7) ? worldArchive.last :
    frameDate(month, new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate());
  return [first, last];
}

function setWorldPeriod(span) {
  if (span.start < worldArchive.first || span.end > worldArchive.last || span.start > span.end) return;
  activePeriod = span;
  map.closePopup();
  const { start, end } = span;
  const range = start !== end;
  const day = range ? end : start;
  const filter = $('world-satellite');
  const detailDays = worldArchive.periodDetailDays ?? 31;
  const publisherRange = daysBetween(start, end) + 1 > detailDays;
  if (publisherRange && !filter.disabled) dailySatellite = filter.value;
  if (publisherRange) filter.value = '';
  else if (filter.disabled) filter.value = dailySatellite;
  filter.disabled = publisherRange;
  filter.title = publisherRange ? `Фильтр по спутнику доступен для периодов до ${detailDays} дней.` : '';
  $('world-date').value = day;
  $('world-date').closest('label').hidden = range;
  $('frame-date').textContent = range ? `${shortDate.format(new Date(start))} — ${shortDate.format(new Date(end))}`
    : dayFormatter.format(new Date(day));
  const slider = $('day-slider');
  const [first, last] = sliderRange(day);
  slider.min = 0;
  slider.max = daysBetween(first, last);
  slider.value = daysBetween(first, day);
  slider.setAttribute('aria-valuetext', $('frame-date').textContent);
  $('play-frames').disabled = first === last;
  document.querySelector('.timeline-controls').hidden = range;
  $('show-period-days').hidden = !range && !inspectionPeriod;
  $('show-period-days').textContent = range ? 'Смотреть по дням' : 'Сводка за период';
  const through = worldArchive.through;
  $('archive-caption').textContent = range ? `Слои на ${shortDate.format(new Date(end))}`
    : day === worldArchive.last && through?.startsWith(day)
    ? `Данные до ${through.slice(11, 16)} UTC`
    : 'Архив FIRMS · время UTC';
  return Promise.all([renderLayers(), loadWorldFrame()]);
}

function setWorldDate(day, keepInspection = false) {
  if (!keepInspection) inspectionPeriod = undefined;
  return setWorldPeriod({ start: day, end: day, mode: 'day' });
}

async function loadArchive() {
  try {
    worldArchive = await getJSON('/api/fires/range');
    for (const [index, label] of worldArchive.platforms.entries()) {
      $('world-satellite').add(new Option(label, index));
    }
    $('world-date').min = worldArchive.first;
    $('world-date').max = worldArchive.last;
    createPeriodPicker(worldArchive, () => activePeriod, (span) => {
      stopPlayback();
      inspectionPeriod = undefined;
      setWorldPeriod(span);
    });
    for (const id of ['world-satellite', 'world-date', 'day-slider', 'play-frames', 'open-period', 'world-wind-flow']) $(id).disabled = false;
    $('play-weather').disabled = !renderExtraLayers;
    await setWorldDate(worldArchive.last);
  } catch (error) {
    $('frame-date').textContent = 'Архив недоступен';
    mapStatus('Не удалось подключиться к мировому архиву FIRMS.');
    console.error(error);
  }
}

function togglePlayback() {
  if (playbackTimer !== undefined) {
    stopPlayback();
    return;
  }
  const current = $('world-date').value;
  const [first, last] = sliderRange(current);
  $('play-frames').textContent = 'Ⅱ Пауза';
  const advance = async (day) => {
    const playing = playbackTimer;
    if ($('world-wind-flow').checked && day < last) worldWind.prefetch(addDays(day, 1));
    await setWorldDate(day, true);
    if (playbackTimer !== playing) return;
    if (day === last) return stopPlayback();
    playbackTimer = setTimeout(() => advance(addDays(day, 1)), 850);
  };
  playbackTimer = setTimeout(() => advance(current === last ? first : current), 0);
}

function toggleWeatherPlayback() {
  if ($('play-weather').getAttribute('aria-pressed') === 'true') {
    stopPlayback();
    return;
  }
  const fields = ['world-wind-flow', 'overlay-world-clouds', 'overlay-world-precip'].map($);
  if (!fields.some((field) => field.checked)) {
    for (const field of fields) {
      field.checked = true;
      field.dispatchEvent(new Event('change'));
    }
  }
  if (activePeriod.start !== activePeriod.end) {
    inspectionPeriod = activePeriod;
    setWorldDate(activePeriod.start, true);
  }
  if (playbackTimer === undefined && !$('play-frames').disabled) togglePlayback();
  if (playbackTimer !== undefined) {
    $('play-weather').setAttribute('aria-pressed', 'true');
    $('play-weather').textContent = 'Ⅱ Пауза';
  }
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
  monthIndex = index;
  renderCalendar();
  renderComparison(row);
  $('calendar-selection').textContent = `День пика · ${periodLabel(row.month)} ↗`;
}

function setupPanels() {
  const analysis = $('analysis-panel');
  const layers = $('map-layer-controls');
  const layersToggle = $('open-layers');
  const tabs = [...document.querySelectorAll('.tool-nav a')];
  const toggles = [...tabs, layersToggle];
  const toolbar = document.querySelector('.topbar');
  new ResizeObserver(() => {
    $('top').style.setProperty('--panel-top', `${Math.ceil(toolbar.getBoundingClientRect().bottom + 7)}px`);
  }).observe(toolbar);
  const sections = {
    '#season-calendar': ['calendar-analysis', 'Календарь и норма · СКО'],
    '#correlations': ['correlations', 'Связи · СКО'],
    '#kishkenekol-case': ['kishkenekol-case', 'Кейс Кишкенеколя'],
  };
  function closePanel() {
    const active = toggles.find((tab) => tab.getAttribute('aria-expanded') === 'true');
    for (const tab of toggles) tab.setAttribute('aria-expanded', 'false');
    analysis.hidden = layers.hidden = true;
    areaAnalysis?.resetDraft();
    if (Object.hasOwn(sections, location.hash)) history.replaceState(null, '', '#observations');
    active?.focus({ preventScroll: true });
  }
  function openAnalysis(hash) {
    const selected = sections[hash];
    if (!Object.hasOwn(sections, hash)) return closePanel();
    layers.hidden = true;
    areaAnalysis?.resetDraft();
    layersToggle.setAttribute('aria-expanded', 'false');
    for (const tab of tabs) tab.setAttribute('aria-expanded', String(tab.hash === hash));
    for (const [id] of Object.values(sections)) $(id).hidden = id !== selected[0];
    $('analysis-heading').textContent = selected[1];
    analysis.hidden = false;
    analysis.scrollTop = 0;
  }
  for (const tab of tabs) {
    tab.addEventListener('click', (event) => {
      event.preventDefault();
      if (tab.getAttribute('aria-expanded') === 'true') return closePanel();
      history.replaceState(null, '', tab.hash);
      openAnalysis(tab.hash);
    });
  }
  layersToggle.addEventListener('click', () => {
    if (!layers.hidden) return closePanel();
    closePanel();
    layers.hidden = false;
    layersToggle.setAttribute('aria-expanded', 'true');
  });
  for (const button of document.querySelectorAll('[data-close-panel]')) button.addEventListener('click', closePanel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('method').open && !$('period-picker').open
      && (!analysis.hidden || !layers.hidden || areaAnalysis?.active())) closePanel();
  });
  window.addEventListener('hashchange', () => openAnalysis(location.hash));
  if (Object.hasOwn(sections, location.hash)) openAnalysis(location.hash);
  return closePanel;
}

async function start() {
  $('open-method').addEventListener('click', () => $('method').showModal());
  const closePanel = setupPanels();
  try {
    const [basemap, boundary, regionalCalendar] = await Promise.all([
      getJSON('data/basemap.geojson'), getJSON('data/region.geojson'), getJSON('data/calendar.json?v=sko-series'),
    ]);
    calendar = regionalCalendar;
    const reset = createMap(basemap, boundary, closePanel);
    $('sko-example').addEventListener('click', () => {
      stopPlayback();
      dailySatellite = '';
      $('world-satellite').value = '';
      reset();
      setWorldDate(kishkenekolDay);
    });
    for (const id of ['fire-layer', 'fire-points', 'fire-heat']) $(id).disabled = false;
    $('local-layers').disabled = false;
    const extraControls = $('extra-layer-controls');
    extraControls.addEventListener('layer-tile-error', ({ detail }) => {
      $('map-layer-status').textContent = `${detail} · часть спутниковых плиток недоступна.`;
      $('map-layer-status').hidden = false;
    });
    createExtraLayers(map, extraControls, getJSON, renderLayers)
      .then((render) => { renderExtraLayers = render; $('play-weather').disabled = !worldArchive; renderLayers(); })
      .catch((error) => {
        $('map-layer-status').textContent = 'Не удалось загрузить каталог дополнительных слоёв.';
        $('map-layer-status').hidden = false;
        console.error(error);
      });
    makeCalendar();
    for (const id of ['source', 'activity-view', 'deviation-view']) $(id).disabled = false;
    $('source').addEventListener('change', (event) => {
      source = event.target.value;
      chooseMonth(monthIndex);
    });
    $('activity-view').addEventListener('click', () => { mode = 'activity'; renderCalendar(); });
    $('deviation-view').addEventListener('click', () => { mode = 'deviation'; renderCalendar(); });
    $('calendar-selection').addEventListener('click', async (event) => {
      event.preventDefault();
      if (!worldArchive) return;
      const index = monthIndex;
      const row = calendar.months[index];
      const platform = monthSource(row);
      try {
        if (!cachedCells.has(row.month)) cachedCells.set(row.month, getJSON(`data/${row.month}.json?v=sko-time`));
        const data = await cachedCells.get(row.month);
        if (index !== monthIndex || $('analysis-panel').hidden) return;
        const counts = data.frames.map((frame) => frame?.[platform].length ?? 0);
        const largest = Math.max(...counts);
        if (!largest) {
          $('calendar-selection').textContent = 'В этом месяце нет ячеек с сигналом';
          return;
        }
        const day = frameDate(row.month, counts.indexOf(largest) + 1);
        const satellite = ['Aqua', 'Suomi NPP', 'NOAA-20'][platform];
        dailySatellite = String(worldArchive.platforms.indexOf(satellite));
        $('world-satellite').value = dailySatellite;
        $('fire-layer').checked = true;
        closePanel();
        stopPlayback();
        reset();
        setWorldDate(day);
      } catch (error) {
        cachedCells.delete(row.month);
        if (index !== monthIndex) return;
        $('calendar-selection').textContent = 'Не удалось найти день пика. Повторите попытку.';
        console.error(error);
      }
    });
    $('case-atlas').hidden = false;
    $('case-atlas').addEventListener('click', () => {
      if (!worldArchive) return;
      stopPlayback();
      closePanel();
      dailySatellite = String(worldArchive.platforms.indexOf('NOAA-20'));
      $('world-satellite').value = dailySatellite;
      $('fire-layer').checked = true;
      map.fitBounds([[53.035, 71.68], [53.346, 72.013]], { padding: [22, 70], animate: false });
      setWorldDate(kishkenekolDay);
    });
    $('local-layers').addEventListener('change', renderLayers);
    $('world-wind-flow').addEventListener('change', renderLayers);
    $('play-weather').addEventListener('click', toggleWeatherPlayback);
    $('fire-layer').addEventListener('change', loadWorldFrame);
    $('fire-detail-retry').addEventListener('click', fireViewport.retry);
    for (const [id, view] of [['fire-points', 'points'], ['fire-heat', 'heat']]) {
      $(id).addEventListener('click', () => {
        fireDisplay = view;
        $('fire-points').setAttribute('aria-pressed', String(view === 'points'));
        $('fire-heat').setAttribute('aria-pressed', String(view === 'heat'));
        loadWorldFrame();
      });
    }
    $('world-satellite').addEventListener('change', loadWorldFrame);
    $('world-date').addEventListener('change', ({ target }) => {
      if (!target.value || !target.validity.valid) return;
      stopPlayback();
      setWorldDate(target.value);
    });
    $('day-slider').addEventListener('input', ({ target }) => {
      stopPlayback();
      const [first] = sliderRange($('world-date').value);
      setWorldDate(addDays(first, Number(target.value)), true);
    });
    $('show-period-days').addEventListener('click', () => {
      stopPlayback();
      if (inspectionPeriod) {
        const span = inspectionPeriod;
        inspectionPeriod = undefined;
        setWorldPeriod(span);
      } else {
        inspectionPeriod = activePeriod;
        setWorldDate(activePeriod.start, true);
      }
    });
    $('play-frames').addEventListener('click', togglePlayback);
    const initial = calendar.months.findIndex((row) => row.month === kishkenekolDay.slice(0, 7));
    chooseMonth(Math.max(0, initial));
    loadArchive();
  } catch (error) {
    mapStatus('Не удалось загрузить атлас.');
    console.error(error);
  }
}

start();
