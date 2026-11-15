import { numberFormat, dateFormat } from './i18n.js';
'use strict';

import { createExtraLayers } from './map-layers.js?v=atlas-polish';
import { createWorldWind } from './world-wind.js?v=atlas-polish';
import { createWeatherOverlay } from './weather-overlay.js?v=layer-values';
import { createFireOverlay, fireDetailZoom } from './fire-overlay.js?v=period-detail';
import { createFireViewport } from './fire-viewport.js?v=paired-days';
import { createAreaAnalysis, inRing } from './area-analysis.js?v=atlas-polish';
import { createMapNotice } from './map-notice.js';
import { createAreaLayerClip } from './area-layer-clip.js?v=atlas-polish';
import { createTerritorySearch } from './territory-search.js';
import { createTerritoryContext } from './territory-context.js';
import { createAtlasStudy } from './atlas-study.js?v=demo-sko';
import { createLayerReadout } from './layer-values.js?v=atlas-polish';
import { addTerrainControl } from './terrain-layer.js';
import { createTemperatureBackground } from './surface-temperature.js';
import { setLayerBusy } from './layer-status.js';
import { addDays, createPeriodPicker, daysBetween } from './period-picker.js?v=atlas-periods';

export function mountAtlas(root, bridge = {}) {
const $ = (id) => root.querySelector('#' + id);
let active = bridge.isActive?.('atlas') !== false;
let activation = 0;
let showPanel;
let currentPanel;
let savedCamera;
let analysisPreferences = { grid_km:10, quality:'sp', daynight:'all', study:null };
const sources = ['Aqua / MODIS', 'Suomi NPP / VIIRS', 'NOAA-20 / VIIRS'];
const sourceTags = ['MODIS', 'Suomi', 'NOAA‑20'];
const detailedImageryMinZoom = 6;
const atlasMaxZoom = 17;
const mercatorLimit = 85.0511287798;
const kishkenekolDay = '2025-04-12';
const monthNames = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const fullMonths = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const number = numberFormat({ maximumFractionDigits: 1 });
const percent = numberFormat({ style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });
const unsignedPercent = numberFormat({ style: 'percent', maximumFractionDigits: 0 });
const activityKey = [['activity-0', '0'], ['activity-1', 'до 10'], ['activity-2', '10–49'], ['activity-3', '50–149'], ['activity-4', '150–399'], ['activity-5', '400+']];
const deviationKey = [['below-2', '−50% и ниже'], ['below-1', 'ниже нормы'], ['near-norm', 'в пределах ±10%'], ['above-1', 'выше нормы'], ['above-2', '+50% и выше']];

let calendar;
let map;
let weatherOverlay;
let worldWind;
let fireOverlay;
let fireViewport;
let viewportFrame;
let displayedViewport;
let areaAnalysis;
let areaClip;
let territoryContext;
let study;
let clearLayerReadout;
let detailNoticeRevision = 0;
const detailNotice = createMapNotice($('fire-detail-notice'));
let terrain;
let temperature;
let fireDisplay = 'points';
let worldArchive;
let worldFrame;
let loadedFrame;
let requestedFire;
let worldRequest;
let activePeriod;
let inspectionPeriod;
let dailySatellite = '';
let playback;
let dayWeather;
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

const dayFormatter = dateFormat({ day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

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

async function getJSON(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response.json();
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
      interactive: false, keyboard: false, pane: 'selected-region',
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
    ++detailNoticeRevision;
    viewportFrame = frame;
    map.closePopup();
    if (!presentFireFrame()) renderFireLayer();
  });
  map.on('moveend resize', () => {
    if (!active || !requestedFire || activePeriod.start !== activePeriod.end) return;
    if (requestedFire.local !== useLocalDay()) loadWorldFrame();
    else if (worldFrame?.local) showWorldFrame();
  });
  areaClip = createAreaLayerClip(map);
  const contextSearch = createTerritorySearch(getJSON, () => boundary.geometry);
  territoryContext = createTerritoryContext(map, $('atlas-territory-context'));
  const scopedLayers = (roi) => {
    $('map').classList.toggle('show-sko-context', roi?.preset === 'sko');
    areaClip.select(roi);
    territoryContext.select(roi, {load: ({signal}) => contextSearch.children(roi, {signal})});
    const scopeName = roi?.name || 'Весь мир';
    $('layer-scope').textContent = roi ? `Наложения внутри границы · ${scopeName}` : 'Слои на всей карте';
    $('open-area').textContent = roi ? 'Выбранная область' : 'Обзор мира';
    for (const id of ['area-open-analysis', 'atlas-open-analysis', 'area-radius-open-analysis']) {
      const available = id === 'area-radius-open-analysis' ? Boolean(roi?.circle) : Boolean(roi);
      $(id).hidden = !available;
      $(id).disabled = !available;
    }
    const regional = !roi || areaAnalysis.intersectsRegion();
    $('local-layers').hidden = !regional;
    root.querySelector('[data-sko-layer]')?.toggleAttribute('hidden', !regional);
    renderLayers();
  };
  areaAnalysis = createAreaAnalysis(map, () => { map.closePopup(); closePanel(); }, getJSON, boundary.geometry, {
    scope: root,
    onChange: roi => {
      analysisPreferences.study = analysisPreferences.study ? { ...analysisPreferences.study, optionId:null, stage:'idle', appliedSignature:null } : null;
      bridge.setContext?.({ roi, study:analysisPreferences.study });
      study.setScope(roi);
      scopedLayers(roi);
      if (roi) showPanel('#selected-area');
    },
  });
  $('world-view').addEventListener('click', () => {
    if (areaAnalysis.getSelection()?.preset === 'sko') areaAnalysis.clearSelection();
  });
  $('reset-map').addEventListener('click', () => {
    areaAnalysis.setSelection({ preset: 'sko', source: boundary.properties?.source || 'Граница СКО · geoBoundaries' });
    study.usePreparedSko();
  });
  weatherOverlay = createWeatherOverlay(map, boundary, (date) => dayFormatter.format(new Date(date)), root);
  worldWind = createWorldWind(map, $('world-wind-status'));
  temperature = createTemperatureBackground(map, $('temperature-status'),
    busy => setLayerBusy($('overlay-world-temperature'), busy, 'gfs'));
  clearLayerReadout = createLayerReadout(map, $('layer-readout'), async event => {
    const wind = $('world-wind-flow').checked ? worldWind.inspect(event.latlng) : undefined;
    const rasters = (await renderExtraLayers?.inspect(event) ?? []).filter(Boolean);
    const satellite = rasters.find(item => item.id === 'world-temperature');
    const estimate = $('overlay-world-temperature')?.checked && (!satellite || satellite.missing)
      ? temperature.inspect(event.latlng) : undefined;
    return [terrain?.inspect(event.latlng), wind, ...weatherOverlay.inspect(event.latlng),
      ...rasters.filter(item => !(item === satellite && estimate)), estimate];
  }, latlng => active && !areaAnalysis.drawing() && areaAnalysis.contains(latlng));

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
  L.control.scale({ metric: true, imperial: false, position: 'bottomleft', maxWidth: 88 }).addTo(map);
  const reset = () => {
    $('map').classList.add('show-sko-context');
    map.fitBounds(regionalBounds, { padding: [30, Math.min(180, map.getSize().y * .23)], animate: false });
  };
  const showWorld = () => {
    $('map').classList.remove('show-sko-context');
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
  terrain = addTerrainControl(map, $);
  $('terrain-layer').addEventListener('change', clearLayerReadout);
  return reset;
}

function mapStatus(message) {
  const node = $('map-message');
  node.textContent = message;
  node.hidden = !message;
}

function fireLoading(message) {
  const label = $('fire-loading-label');
  if (message && label.textContent !== message) label.textContent = message;
  $('fire-loading').hidden = !message;
}

function updateFireLoading() {
  const visible = $('fire-layer').checked;
  const grouped = activePeriod && activePeriod.start !== activePeriod.end;
  const viewport = requestedFire?.local || (grouped && map.getZoom() >= fireDetailZoom);
  const message = viewport && viewportFrame?.status === 'loading' ? 'Загружаем детекции на этом участке…'
    : worldRequest && (!viewport || !viewportFrame || viewportFrame.status === 'ok')
      ? grouped ? 'Загружаем сводку за период…' : 'Загружаем детекции за день…' : '';
  const waitingForWeather = !grouped && dayWeather && dayWeather.day === activePeriod?.start && !dayWeather.ready;
  const label = visible && message ? message : waitingForWeather ? 'Загружаем погоду за день…' : '';
  setLayerBusy($('fire-layer'), Boolean(visible && message));
  fireLoading(label ? `${label} ${firePeriodLabel(activePeriod)} UTC` : '');
}

function stopPlayback() {
  clearTimeout(playback?.timer);
  playback = undefined;
  fireViewport?.cancelPrefetch();
  $('play-frames').replaceChildren(element('span', '▶'), document.createTextNode(' Воспроизвести'));
  $('play-frames').firstChild.setAttribute('aria-hidden', 'true');
  $('play-weather').setAttribute('aria-pressed', 'false');
  $('play-weather').textContent = '▶ Погода';
}

async function prepareLocalWeather(date) {
  try {
    weatherData ??= getJSON('data/weather.json?v=sko-layers');
    const data = await weatherData;
    return data.days[date] ? { data } : { message: `Архивная погода СКО за ${date} UTC недоступна.` };
  } catch (error) {
    weatherData = undefined;
    console.error(error);
    return { message: `Не удалось загрузить архивную погоду за ${date} UTC.` };
  }
}

function displayWeather({ day, world, local }) {
  worldWind.display(world);
  if (local?.data) weatherOverlay.show(local.data, day, $('weather-field').value, false);
  else weatherOverlay.clear(local?.message);
}

function prepareDayWeather(day, previousDayAllowed) {
  const worldEnabled = $('world-wind-flow').checked;
  const localEnabled = !$('local-layers').hidden && Boolean($('weather-field').value);
  const key = `${day}/${worldEnabled}/${localEnabled}/${previousDayAllowed}`;
  if (dayWeather?.key === key) return dayWeather;
  const current = { day, key, ready: !worldEnabled && !localEnabled };
  dayWeather = current;
  if (!worldEnabled) worldWind.display();
  setLayerBusy($('world-wind-flow'), worldEnabled);
  setLayerBusy($('weather-field'), localEnabled);
  if (!localEnabled) weatherOverlay.clear();
  if (current.ready) return current;
  current.promise = Promise.all([
    worldEnabled ? worldWind.prepare(day, previousDayAllowed) : undefined,
    localEnabled ? prepareLocalWeather(day) : undefined,
  ]).then(([world, local]) => {
    Object.assign(current, { world, local, ready: true });
    if (dayWeather === current) {
      setLayerBusy($('world-wind-flow'), false);
      setLayerBusy($('weather-field'), false);
    }
  });
  return current;
}

async function renderLayers(day = $('world-date').value) {
  syncWeatherOff();
  const request = ++layerRequest;
  const date = typeof day === 'string' ? day : $('world-date').value;
  if (!date || !active) return;
  clearLayerReadout?.();
  temperature.show($('overlay-world-temperature')?.checked ? date : undefined);
  const daily = activePeriod?.start === activePeriod?.end;
  const weather = prepareDayWeather(date, !daily);
  const month = date.slice(0, 7);
  const status = $('map-layer-status');
  status.hidden = true;
  status.textContent = '';
  const layers = renderExtraLayers?.(month, date);
  if (weather.promise) await weather.promise;
  if (request !== layerRequest || !active) return;
  if (!daily) displayWeather(weather);
  else if (!presentFireFrame()) {
    if (worldFrame?.start === date && worldFrame?.end === date) displayWeather(weather);
    updateFireLoading();
  }
  const events = await layers;
  if (request !== layerRequest) return;
  const items = (events ?? []).filter(Boolean);
  if (activePeriod?.start !== activePeriod?.end && items.length) items.unshift(`Дата спутниковых слоёв и погоды · ${date} UTC`);
  const summary = $('visible-layer-summary');
  summary.replaceChildren(...items.map((item) => element('li', item)));
  summary.hidden = items.length === 0;
}

function firePoints() {
  const points = worldFrame?.points ?? noFirePoints;
  const satellite = worldFrame?.satellite;
  if (!satellite || worldFrame.approximate) return points;
  return points.filter((point) => point[2] === Number(satellite));
}

function renderFireLayer(points = firePoints()) {
  const visible = $('fire-layer').checked;
  const grouped = Boolean(worldFrame && worldFrame.start !== worldFrame.end);
  const detail = displayedViewport?.status === 'ok' ? displayedViewport.points : undefined;
  const waitingForDetail = grouped && !detail && map.getZoom() >= fireDetailZoom;
  $('heat-legend').hidden = !visible || fireDisplay !== 'heat' || waitingForDetail;
  $('heat-legend').lastChild.textContent = grouped && !detail ? ' Плотность по сводке' : ' Плотность детекций';
  $('world-point-legend').hidden = !visible || fireDisplay !== 'points' || waitingForDetail;
  $('world-point-legend').classList.toggle('grouped', grouped && !detail);
  $('world-point-legend').lastChild.textContent = grouped && !detail ? ' Группы детекций' : ' Пиксели MODIS / VIIRS';
  const status = viewportFrame?.status;
  const coverage = viewportFrame?.missing?.length ? ' В архиве есть пропуски дат.' : '';
  const retainingPrevious = worldFrame && (worldFrame.path !== requestedFire?.path || worldFrame.satellite !== requestedFire?.satellite
    || (worldFrame.local && !displayedViewport?.coversView()));
  const detailFailure = ['too_wide', 'too_dense', 'too_slow', 'unavailable', 'error'].includes(status);
  const provenance = viewportFrame === displayedViewport && status === 'ok'
    ? `${viewportFrame.points.length ? (viewportFrame.method === 'archive' ? 'Исходный архив · без фильтра качества.' : '')
      : 'В архиве для этого участка нет детекций.'}${coverage}`.trim() : '';
  $('fire-detail-provenance').textContent = visible ? provenance : '';
  $('fire-detail-provenance').hidden = !visible || !provenance;
  const message = {
    too_wide: 'Приблизьте карту, чтобы увидеть отдельные детекции.',
    too_dense: 'Слишком много детекций. Приблизьте карту или сократите период.',
    too_slow: viewportFrame?.reason === 'busy' ? 'Сервер ещё загружает предыдущий участок. Повторите запрос.'
      : 'Область загружается долго. Приблизьте карту или сократите период.',
    unavailable: 'Исходные детекции за этот период недоступны.',
    error: 'Детекции на этом участке не загрузились.',
  }[status];
  if (visible && detailFailure) detailNotice.show({
    key: `${requestedFire?.path}/${requestedFire?.start}/${requestedFire?.end}/${requestedFire?.satellite}/${detailNoticeRevision}/${status}/${viewportFrame?.reason || ''}`,
    message: `${message}${retainingPrevious ? ' На карте остаются предыдущие данные.' : ''}`,
  });
  else detailNotice.clear();
  const retry = $('fire-detail-retry');
  const retryPending = visible && status === 'loading' && !retry.hidden;
  retry.hidden = !visible || (!retryPending && !['error', 'too_slow'].includes(status));
  retry.setAttribute('aria-disabled', String(retryPending));
  retry.setAttribute('aria-busy', String(retryPending));
  const regionalCount = fireOverlay(points, fireDisplay, visible, grouped, detail);
  updateFireLoading();
  return regionalCount;
}

function viewportLimits() {
  return {
    maxWidth: worldArchive.viewportMaxWidth ?? 20, maxHeight: worldArchive.viewportMaxHeight ?? 15,
  };
}

function useLocalDay() {
  return fireViewport.fits(viewportLimits());
}

function viewportQuery(start, end, satellite) {
  return { start, end, satellite, ...viewportLimits(), key: `${start}/${end}/${satellite}` };
}

function updateFireViewport() {
  if (!active || !requestedFire) return fireViewport.select(undefined);
  const { start, end, satellite, local } = requestedFire;
  return fireViewport.select(local || (start !== end && $('fire-layer').checked)
    ? viewportQuery(start, end, satellite) : undefined, local);
}

function renderAreaFrame(points = firePoints(), failed = false) {
  const approximate = Boolean(worldFrame?.approximate);
  const span = worldFrame ?? activePeriod;
  const date = span.start === span.end ? span.start : firePeriodLabel(span);
  areaAnalysis.render({ date, points: worldFrame && !worldFrame.local ? points : undefined, failed, local: worldFrame?.local,
    worldTotal: worldFrame && !worldFrame.local ? worldFrame.total ?? points.length : undefined,
    platforms: worldArchive.platforms, approximate, cellDegrees: worldFrame?.cellDegrees,
    regionalByPlatform: worldFrame?.regionalByPlatform, regionalExact: worldFrame?.regionalExact, viewport: displayedViewport });
}

function showWorldFrame() {
  publishContext();
  const visible = $('fire-layer').checked;
  const selectedPoints = firePoints();
  const approximate = Boolean(worldFrame?.approximate);
  const local = Boolean(worldFrame?.local);
  const drawnRegionalCount = renderFireLayer(selectedPoints);
  const regionalCount = worldFrame?.regionalCount ?? drawnRegionalCount;
  renderAreaFrame(selectedPoints);
  const displayedDate = $('fire-frame-date');
  const displayedSatellite = worldFrame && worldFrame.satellite !== $('world-satellite').value
    ? worldArchive.platforms[worldFrame.satellite || -1] ?? 'Все спутники' : '';
  const dateLabel = worldFrame ? `Детекции за ${firePeriodLabel(worldFrame)} UTC${displayedSatellite ? ` · ${displayedSatellite}` : ''}` : '';
  if (displayedDate.textContent !== dateLabel) displayedDate.textContent = dateLabel;
  displayedDate.classList.toggle('same-frame', Boolean(worldFrame && worldFrame.start === activePeriod.start
    && worldFrame.end === activePeriod.end && !displayedSatellite));
  displayedDate.hidden = !visible || !worldFrame;
  $('map-summary').textContent = !visible ? 'Слой выключен'
    : local ? (displayedViewport.coversView()
      ? `В кадре · ${number.format(displayedViewport.countVisible())} детекций` : 'Детекции предыдущего участка')
    : worldFrame ? `Мир · ${number.format(worldFrame.total ?? selectedPoints.length)} детекций` : 'Загрузка детекций…';
  const regionalPrefix = approximate && !worldFrame.regionalExact ? '≈ ' : '';
  $('regional-count').textContent = visible && worldFrame && !local ? `СКО · ${regionalPrefix}${number.format(regionalCount)}` : '';
  $('sko-example').hidden = !visible || !worldFrame || worldFrame.path !== requestedFire?.path || local || regionalCount > 0 || approximate
    || kishkenekolDay < worldArchive.first || kishkenekolDay > worldArchive.last;
  if (worldFrame?.method === 'publisher' && worldFrame.path === requestedFire?.path) {
    const through = worldFrame.coveredEnd;
    const missing = worldFrame.missing?.reduce((days, gap) => days + 1 + daysBetween(gap.start, gap.end), 0) ?? 0;
    $('archive-caption').textContent = `Архивные сводки без фильтра качества${through ? ` · до ${shortDate.format(new Date(through))}` : ''}${missing ? ` · пропусков: ${missing} дн.` : ''}`;
  }
  if (visible && worldFrame && !local && worldFrame.path === requestedFire?.path && (worldFrame.total ?? selectedPoints.length) === 0) {
    mapStatus(`За ${firePeriodLabel(worldFrame)} UTC нет записей этих спутников. Покрытие неизвестно.`);
  }
}

function presentFireFrame() {
  if (!active || !requestedFire) return false;
  const { start, end, satellite, path, local } = requestedFire;
  const daily = start === end;
  if (daily && (activePeriod.start !== start || activePeriod.end !== end)) return false;
  if (local) {
    if (!useLocalDay()) return false;
    if (viewportFrame?.status !== 'ok') {
      if (!worldFrame && viewportFrame && viewportFrame.status !== 'loading') {
        $('map-summary').textContent = 'Данные участка недоступны';
        renderAreaFrame(undefined, true);
      }
      if (playback?.day === start && playback.timer === undefined && viewportFrame && viewportFrame.status !== 'loading') stopPlayback();
      return false;
    }
    if (!viewportFrame.coversView() || !dayWeather?.ready || dayWeather.day !== start) return false;
    worldFrame = { start, end, satellite, path, local, points: viewportFrame.points };
    displayedViewport = viewportFrame;
  } else {
    if (loadedFrame?.path !== path || (daily && (!dayWeather?.ready || dayWeather.day !== start))) return false;
    const needsDetail = !daily && map.getZoom() >= fireDetailZoom && $('fire-layer').checked;
    const sameFrame = worldFrame?.path === path && worldFrame.satellite === satellite;
    const detailReady = viewportFrame?.status === 'ok';
    if (needsDetail && !detailReady && (!viewportFrame || viewportFrame.status === 'loading' || (worldFrame && !sameFrame))) return false;
    worldFrame = { ...loadedFrame, start, end, satellite };
    displayedViewport = needsDetail && detailReady ? viewportFrame : undefined;
  }
  if (daily) displayWeather(dayWeather);
  mapStatus('');
  showWorldFrame();
  if (daily) scheduleNextDay(start);
  return true;
}

async function loadWorldFrame() {
  if (!worldArchive || !activePeriod) return;
  const { start, end } = activePeriod;
  const range = start !== end;
  const params = new URLSearchParams({ start, end });
  const satellite = $('world-satellite').value;
  if (satellite !== '') params.set('satellite', satellite);
  const local = !range && useLocalDay();
  const path = local ? `viewport:${start}/${satellite}` : range ? `/api/fires/period?${params}` : `/api/fires/${start}`;
  requestedFire = { path, start, end, satellite, local };
  if (local) {
    worldRequest?.controller.abort();
    worldRequest = undefined;
    mapStatus('');
    const pending = updateFireViewport();
    showWorldFrame();
    return pending;
  }
  if (worldRequest?.path === path) {
    updateFireViewport();
    showWorldFrame();
    return worldRequest.promise;
  }
  worldRequest?.controller.abort();
  worldRequest = undefined;
  if (loadedFrame?.path === path || worldFrame?.path === path) {
    loadedFrame = loadedFrame?.path === path ? loadedFrame : worldFrame;
    updateFireViewport();
    if (!presentFireFrame()) showWorldFrame();
    return;
  }
  const controller = new AbortController();
  const request = { path, controller };
  worldRequest = request;
  loadedFrame = undefined;
  mapStatus('');
  updateFireViewport();
  showWorldFrame();
  request.promise = (async () => {
    try {
      const response = await fetch(path, { signal: controller.signal, cache: range ? 'no-cache' : 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const frame = await response.json();
      if (controller.signal.aborted) return;
      loadedFrame = { ...frame, path };
      worldRequest = undefined;
      if (!presentFireFrame()) renderFireLayer();
    } catch (error) {
      if (controller.signal.aborted) return;
      renderAreaFrame(undefined, true);
      if (!worldFrame) $('map-summary').textContent = 'Данные мира недоступны';
      mapStatus(`Не удалось загрузить детекции за ${firePeriodLabel(activePeriod)} UTC.${worldFrame ? ' На карте остаются предыдущие данные.' : ''}`);
      if (playback?.day === start && playback.timer === undefined) stopPlayback();
    } finally {
      if (worldRequest === request) worldRequest = undefined;
      if (!controller.signal.aborted) updateFireLoading();
    }
  })();
  return request.promise;
}

const shortDate = dateFormat({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

function firePeriodLabel({ start, end }) {
  const first = shortDate.format(new Date(start));
  return start === end ? first : `${first} — ${shortDate.format(new Date(end))}`;
}

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
  $('frame-date').textContent = range ? firePeriodLabel(span)
    : dayFormatter.format(new Date(day));
  const slider = $('day-slider');
  const [first, last] = sliderRange(day);
  slider.min = 0;
  slider.max = daysBetween(first, last);
  slider.value = daysBetween(first, day);
  slider.setAttribute('aria-valuetext', $('frame-date').textContent);
  $('play-frames').disabled = first === last;
  root.querySelector('.timeline-controls').hidden = range;
  $('show-period-days').hidden = !range && !inspectionPeriod;
  $('show-period-days').textContent = range ? 'По дням' : 'За период';
  const through = worldArchive.through;
  $('archive-caption').textContent = range ? `Слои на ${shortDate.format(new Date(end))}`
    : day === worldArchive.last && through?.startsWith(day)
    ? `Данные до ${through.slice(11, 16)} UTC`
    : '';
  return Promise.all([renderLayers(), loadWorldFrame()]);
}

function setWorldDate(day, keepInspection = false) {
  if (!keepInspection) inspectionPeriod = undefined;
  return setWorldPeriod({ start: day, end: day, mode: 'day' });
}

async function loadArchive() {
  try {
    worldArchive = await getJSON('/api/fires/range');
    study.setArchive(worldArchive);
    for (const [index, label] of worldArchive.platforms.entries()) {
      $('world-satellite').add(new Option(label, index));
    }
    $('world-date').min = worldArchive.first;
    $('world-date').max = worldArchive.last;
    createPeriodPicker(worldArchive, () => activePeriod, (span) => {
      stopPlayback();
      inspectionPeriod = undefined;
      setWorldPeriod(span);
    }, root);
    for (const id of ['world-satellite', 'world-date', 'day-slider', 'play-frames', 'open-period', 'world-wind-flow']) $(id).disabled = false;
    $('play-weather').disabled = !renderExtraLayers;
  } catch (error) {
    fireLoading('');
    $('frame-date').textContent = 'Архив недоступен';
    mapStatus('Не удалось подключиться к мировому архиву FIRMS.');
    console.error(error);
  }
}

function scheduleNextDay(day) {
  const playing = playback;
  if (!playing || playing.day !== day) return;
  if (day === playing.last) return stopPlayback();
  const next = addDays(day, 1);
  if (useLocalDay()) fireViewport.prefetch(viewportQuery(next, next, $('world-satellite').value));
  if ($('world-wind-flow').checked) worldWind.prefetch(next);
  playing.timer ??= setTimeout(() => advancePlayback(playing, next), 850);
}

function advancePlayback(playing, day) {
  if (playback !== playing) return;
  playing.timer = undefined;
  playing.day = day;
  setWorldDate(day, true);
}

function togglePlayback() {
  if (playback) {
    stopPlayback();
    return;
  }
  const current = $('world-date').value;
  const [first, last] = sliderRange(current);
  const playing = { last };
  playback = playing;
  $('play-frames').textContent = 'Ⅱ Пауза';
  playing.timer = setTimeout(() => advancePlayback(playing, current === last ? first : current), 0);
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
  if (!playback && !$('play-frames').disabled) togglePlayback();
  if (playback) {
    $('play-weather').setAttribute('aria-pressed', 'true');
    $('play-weather').textContent = 'Ⅱ Пауза';
  }
}

function weatherLayerFields() {
  return ['world-wind-flow', 'overlay-world-clouds', 'overlay-world-precip', 'overlay-world-temperature', 'overlay-world-wind'].map($).filter(Boolean);
}

function syncWeatherOff() {
  const enabled = weatherLayerFields().some(field => field.checked) || Boolean($('weather-field').value);
  $('weather-off').hidden = !enabled;
  $('weather-off').disabled = !enabled;
}

function disableWeatherLayers() {
  stopPlayback();
  const changed = weatherLayerFields().filter(field => field.checked);
  for (const field of changed) field.checked = false;
  if ($('weather-field').value) {
    $('weather-field').value = '';
    changed.push($('weather-field'));
  }
  for (const field of changed) field.dispatchEvent(new Event('change', { bubbles: true }));
  syncWeatherOff();
  if (document.activeElement === $('weather-off')) $('play-weather').focus({ preventScroll: true });
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
  const area = $('selected-area-panel');
  const layersToggle = $('open-layers');
  const areaToggle = $('open-area');
  const tabs = [...root.querySelectorAll('.tool-nav a')];
  const toggles = [...tabs, layersToggle, areaToggle];
  const toolbar = root.querySelector('.topbar');
  new ResizeObserver(() => {
    $('top').style.setProperty('--panel-top', `${Math.ceil(toolbar.getBoundingClientRect().bottom - root.getBoundingClientRect().top + 7)}px`);
  }).observe(toolbar);
  const sections = {
    '#activity-calendar': ['atlas-study', 'Календарь активности'],
    '#external-factors': ['atlas-study', 'Внешние связи'],
    '#season-calendar': ['calendar-analysis', 'Календарь и норма · СКО'],
    '#correlations': ['correlations', 'Связи · СКО'],
    '#kishkenekol-case': ['kishkenekol-case', 'Кейс Кишкенеколя'],
  };
  function closePanel() {
    const active = toggles.find((tab) => tab.getAttribute('aria-expanded') === 'true');
    for (const tab of toggles) tab.setAttribute('aria-expanded', 'false');
    analysis.hidden = layers.hidden = area.hidden = true;
    currentPanel = undefined;
    study.show();
    areaAnalysis?.resetDraft();
    if (location.hash !== '#observations' && location.hash) bridge.setLocalHash?.('#observations');
    active?.focus({ preventScroll: true });
  }
  function openAnalysis(hash) {
    currentPanel = hash;
    if (['#season-calendar', '#correlations', '#kishkenekol-case'].includes(hash)) $('map')?.classList.add('show-sko-context');
    if (hash === '#selected-area' || hash === '#layers') {
      const isArea = hash === '#selected-area';
      area.hidden = !isArea;
      layers.hidden = isArea;
      analysis.hidden = true;
      study.show();
      for (const tab of toggles) tab.setAttribute('aria-expanded', String(tab === (isArea ? areaToggle : layersToggle)));
      return;
    }
    const selected = sections[hash];
    if (!Object.hasOwn(sections, hash)) return closePanel();
    layers.hidden = area.hidden = true;
    areaAnalysis?.resetDraft();
    layersToggle.setAttribute('aria-expanded', 'false');
    areaToggle.setAttribute('aria-expanded', 'false');
    for (const tab of tabs) tab.setAttribute('aria-expanded', String(tab.hash === hash));
    for (const [id] of Object.values(sections)) $(id).hidden = id !== selected[0];
    study.show(selected[0] === 'atlas-study' ? hash : undefined);
    $('analysis-heading').textContent = selected[1];
    analysis.hidden = false;
    analysis.scrollTop = 0;
  }
  for (const tab of tabs) {
    tab.addEventListener('click', (event) => {
      event.preventDefault();
      if (tab.getAttribute('aria-expanded') === 'true') return closePanel();
      bridge.setLocalHash?.(tab.hash);
      openAnalysis(tab.hash);
    });
  }
  for (const [toggle, hash] of [[layersToggle, '#layers'], [areaToggle, '#selected-area']]) {
    toggle.addEventListener('click', () => {
      if (currentPanel === hash) return closePanel();
      areaAnalysis?.resetDraft();
      openAnalysis(hash);
    });
  }
  for (const button of root.querySelectorAll('[data-close-panel]')) button.addEventListener('click', closePanel);
  for (const button of root.querySelectorAll('[data-expand-panel]')) button.addEventListener('click', () => {
    const expanded = button.closest('.atlas-panel').classList.toggle('is-expanded');
    button.setAttribute('aria-pressed', String(expanded));
    button.title = expanded ? 'Уменьшить панель' : 'Развернуть панель';
    button.setAttribute('aria-label', button.title);
    button.textContent = expanded ? '⤡' : '⤢';
  });
  document.addEventListener('keydown', (event) => {
    if (!active) return;
    if (event.key === 'Escape' && !$('method').open && !$('period-picker').open
      && (currentPanel || areaAnalysis?.active())) closePanel();
  });
  window.addEventListener('hashchange', () => { if (active) openAnalysis(location.hash); });
  showPanel = openAnalysis;
  if (Object.hasOwn(sections, location.hash)) openAnalysis(location.hash);
  return closePanel;
}

async function start() {
  study = createAtlasStudy(root, () => {
    const source = $('world-satellite').value;
    return source ? normalizePlatform(worldArchive.platforms[Number(source)]) : undefined;
  }, (span, platform) => {
    stopPlayback();
    inspectionPeriod = undefined;
    const id = worldArchive.platforms.findIndex(source => normalizePlatform(source) === platform);
    if (id >= 0) {
      dailySatellite = String(id);
      $('world-satellite').value = dailySatellite;
    }
    setWorldPeriod(span);
  });
  study.setScope(null);
  const closePanel = setupPanels();
  try {
    const [basemap, boundary, regionalCalendar] = await Promise.all([
      getJSON('data/basemap.geojson'), getJSON('data/region.geojson'), getJSON('data/calendar.json?v=sko-series'),
    ]);
    calendar = regionalCalendar;
    const reset = createMap(basemap, boundary, closePanel);
    const openSelectedAnalysis = () => {
      if (areaAnalysis.getSelection()) bridge.navigate?.('analysis', { from: 'atlas', run: false });
    };
    for (const id of ['area-open-analysis', 'atlas-open-analysis', 'area-radius-open-analysis']) $(id).addEventListener('click', openSelectedAnalysis);
    $('open-area').textContent = 'Обзор мира';
    $('sko-example').addEventListener('click', () => {
      stopPlayback();
      closePanel();
      if (areaAnalysis.getSelection()) areaAnalysis.clearSelection();
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
      .then((render) => {
        renderExtraLayers = render;
        root.querySelector('[data-sko-layer]')?.toggleAttribute('hidden', !areaAnalysis.intersectsRegion());
        areaClip.update();
        $('play-weather').disabled = !worldArchive;
        renderLayers();
      })
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
      $('map').classList.add('show-sko-context');
      dailySatellite = String(worldArchive.platforms.indexOf('NOAA-20'));
      $('world-satellite').value = dailySatellite;
      $('fire-layer').checked = true;
      map.fitBounds([[53.035, 71.68], [53.346, 72.013]], { padding: [22, 70], animate: false });
      setWorldDate(kishkenekolDay);
      bridge.navigate?.('atlas', { from: 'case', preserve: true });
    });
    $('local-layers').addEventListener('change', renderLayers);
    $('world-wind-flow').addEventListener('change', renderLayers);
    $('play-weather').addEventListener('click', toggleWeatherPlayback);
    $('weather-off').addEventListener('click', disableWeatherLayers);
    $('fire-layer').addEventListener('change', loadWorldFrame);
    $('fire-detail-retry').addEventListener('click', () => {
      if ($('fire-detail-retry').getAttribute('aria-disabled') !== 'true') fireViewport.retry();
    });
    for (const [id, view] of [['fire-points', 'points'], ['fire-heat', 'heat']]) {
      $(id).addEventListener('click', () => {
        fireDisplay = view;
        $('fire-points').setAttribute('aria-pressed', String(view === 'points'));
        $('fire-heat').setAttribute('aria-pressed', String(view === 'heat'));
        map.closePopup();
        renderFireLayer();
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
    await loadArchive();
  } catch (error) {
    fireLoading('');
    mapStatus('Не удалось загрузить атлас.');
    console.error(error);
  }
}


function normalizePlatform(value) {
  return value === 'Suomi NPP' ? 'Suomi-NPP' : value;
}
function getState() {
  const selected = $('world-satellite')?.value;
  const platform = selected === '' ? 'all' : normalizePlatform(worldArchive?.platforms?.[Number(selected)] || 'all');
  const roi = areaAnalysis?.getSelection?.() || null;
  const settings = study?.getSettings?.();
  const research = settings && (roi || settings.explicit) ? {
    history:{start:settings.start,end:settings.end},baseline:{start:settings.baseline_start,end:settings.baseline_end},
    analysisPlatform:settings.platform === 'auto' ? analysisPreferences.platform || null : settings.platform,
  } : {};
  return {
    context: { roi, ...research, ...analysisPreferences,
      focus: activePeriod ? { start: activePeriod.start, end: activePeriod.end, grain: activePeriod.mode || 'day', basis: 'UTC' } : null,
      platform, atlasQuality: worldFrame?.method === 'publisher' || viewportFrame?.method === 'archive' ? 'publisher_all' : 'atlas_filtered',
    },
    camera: map ? { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() } : null,
    fireDisplay, localPanel: currentPanel, atlasStudy:settings,territoryContext:territoryContext?.getState(),
  };
}
function publishContext() {
  if (active && bridge.isActive?.('atlas') !== false) bridge.setContext?.(getState().context);
}
function getAnalysisContext() {
  const selected = getState().context;
  if (!selected.roi) return null;
  const inherited = bridge.getContext?.() || {};
  const next = { ...inherited, ...selected, history: { ...inherited.history }, baseline: { ...inherited.baseline },
    ...analysisPreferences };
  const start = $('study-start').value, end = $('study-end').value;
  if (start && end) {
    next.history = { start, end };
    next.baseline = { start: $('study-baseline-start').valueAsNumber, end: $('study-baseline-end').valueAsNumber };
  }
  const platform = $('study-platform').value;
  if (['Aqua', 'Terra', 'Suomi-NPP', 'NOAA-20', 'NOAA-21'].includes(platform)) next.platform = platform;
  if (next.focus && (next.focus.start < next.history.start || next.focus.end > next.history.end)) {
    next.focus = null;
    bridge.notice?.('Дата карты вне периода исследования; выберите период в анализе.');
  }
  return next;
}
const ready = start();
return {
  ready, getState, getAnalysisContext,
  async activate(options = {}) {
    const token=++activation;
    active = true;
    await ready;
    if(!active||token!==activation)return;
    map?.invalidateSize({ pan: false });
    const demo = options.view === 'atlas' && new URLSearchParams(location.search).get('demo') === 'sko';
    const demoPanel = location.hash === '#external-factors' ? '#external-factors' : '#activity-calendar';
    const state = demo ? undefined : options.state;
    const context = demo ? undefined : options.context || state?.context;
    if (context) {
      for (const field of ['grid_km','quality','daynight','study']) {
        if (Object.hasOwn(context,field)) analysisPreferences[field] = structuredClone(context[field]);
      }
      const preferred = context.analysisPlatform || context.platform;
      if (['Aqua','Terra','Suomi-NPP','NOAA-20','NOAA-21'].includes(preferred)) analysisPreferences.platform = preferred;
    }
    if (context && Object.hasOwn(context, 'roi')) {
      if (context.roi) areaAnalysis?.setSelection(context.roi);
      else if (areaAnalysis?.getSelection()) areaAnalysis.clearSelection();
    }
    if (state?.atlasStudy) study.restoreSettings(state.atlasStudy);
    else if (context?.history && context?.baseline) {
      study.restoreSettings({start:context.history.start,end:context.history.end,
        baseline_start:context.baseline.start,baseline_end:context.baseline.end,
        platform:context.analysisPlatform || context.platform || 'auto',explicit:true});
    }
    if (context?.platform && worldArchive) {
      const id = context.platform === 'all' ? -1 : worldArchive.platforms.findIndex(p => normalizePlatform(p) === context.platform);
      if (context.platform !== 'all' && id < 0) bridge.notice?.('Эта платформа недоступна в текущем архиве атласа. Фильтр не изменён.');
      else $('world-satellite').value = id < 0 ? '' : String(id);
    }
    const camera = state?.camera || (!context && savedCamera);
    if (camera) map?.setView(camera.center, camera.zoom, { animate: false });
    else if (context?.roi?.bbox) {
      const [w,s,e,n] = context.roi.bbox;
      map?.fitBounds([[s,w],[n,e]], { padding: [45,60], maxZoom: 11, animate: false });
    }
    if (context?.focus && worldArchive) {
      const { start, end } = context.focus;
      if (start < worldArchive.first || end > worldArchive.last) bridge.notice?.('Выбранный период выходит за доступные даты атласа. Период не изменён.');
      else {
        await setWorldPeriod({ start, end, mode: context.focus.grain || 'custom' });
        if(!active||token!==activation)return;
        if(context.platform&&context.platform!=='all'&&$('world-satellite').disabled)bridge.notice?.('Длинная сводка атласа объединяет платформы. Для выбранного спутника перейдите к дням; источник анализа сохранён отдельно.');
      }
    }
    if (worldArchive && !activePeriod) setWorldDate(worldArchive.last);
    if (state?.fireDisplay && ['points','heat'].includes(state.fireDisplay)) {
      fireDisplay = state.fireDisplay;
      $('fire-points').setAttribute('aria-pressed', String(fireDisplay === 'points'));
      $('fire-heat').setAttribute('aria-pressed', String(fireDisplay === 'heat'));
    }
    if (demo) {
      $('reset-map').click();
      showPanel?.(demoPanel);
      bridge.setLocalHash?.(demoPanel);
    } else if (options.caseId || options.view === 'cases') showPanel?.('#kishkenekol-case');
    else if (state?.localPanel) showPanel?.(state.localPanel);
    else if(options.view==='atlas'&&root.querySelector('#kishkenekol-case')&&!root.querySelector('#kishkenekol-case').hidden)showPanel?.('#observations');
    study.resume();
    territoryContext?.resume();
    territoryContext?.setEnabled(state?.territoryContext?.enabled);
    weatherOverlay?.resume?.();
    if(worldArchive)renderLayers();
    if (worldArchive) await loadWorldFrame();
  },
  deactivate() {
    active = false;++activation;
    detailNotice.clear();
    study?.pause();
    territoryContext?.pause();
    worldRequest?.controller.abort();
    worldRequest = undefined;
    if (map) savedCamera = { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() };
    stopPlayback();
    fireViewport?.select(undefined);
    weatherOverlay?.pause?.();
    ++layerRequest;
    dayWeather = undefined;
    worldWind?.display();
    for (const dialog of root.querySelectorAll('dialog[open]')) dialog.close();
  },
  openPanel(hash) { showPanel?.(hash); },
};
}
