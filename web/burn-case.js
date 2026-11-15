import { numberFormat } from './i18n.js';
export function mountBurnCase(root = document) {
const byId = (id) => root.querySelector('#' + id);
const base = 'data/cases/kishkenekol-2025-04-12/';
const number = numberFormat({ maximumFractionDigits: 1 });

async function json(file) {
  const response = await fetch(base + file);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${file}`);
  return response.json();
}

function addPopup(layer, summary, details) {
  const body = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = summary;
  body.append(title, document.createElement('br'), document.createTextNode(details));
  layer.bindPopup(body);
}

async function renderCase() {
  const [study, scar, parcels, detections] = await Promise.all([
    json('study.json'), json('scar.geojson'), json('parcels.geojson'), json('detections.geojson'),
  ]);
  byId('case-result').textContent = `На снимке 16 апреля появился след, похожий на гарь. Выделенный контур занимает около ${number.format(study.areaKm2)} км².`;
  byId('case-overlap').textContent = `Пересечение с контурами ЕГКН — ${number.format(study.overlapPercent)}% выделенного следа (${number.format(study.overlapKm2)} км², участков с пересечением — ${study.intersectingParcels}).`;
  byId('case-layout').hidden = false;
  const bounds = L.latLngBounds(study.bounds);
  const map = L.map(byId('case-map'), {
    minZoom: 7, maxZoom: 15, zoomSnap: .25, zoomAnimation: false,
    scrollWheelZoom: false, attributionControl: false,
  });
  L.imageOverlay('assets/sko-blue-marble.webp', [[46, 57], [61, 84]],
    { className: 'case-map-background', alt: '' }).addTo(map);
  map.createPane('case-after').style.zIndex = 405;
  map.createPane('case-scar').style.zIndex = 410;
  map.createPane('case-parcels').style.zIndex = 420;
  map.createPane('case-detections').style.zIndex = 430;
  const before = L.imageOverlay(base + 'before.webp', bounds,
    { alt: 'Sentinel‑2 до события, 6 апреля 2025 года' }).addTo(map);
  const after = L.imageOverlay(base + 'after.webp', bounds,
    { pane: 'case-after', alt: 'Sentinel‑2 после события, 16 апреля 2025 года' }).addTo(map);
  const slider = byId('case-swipe');
  const split = document.createElement('div');
  split.className = 'case-split';
  split.setAttribute('aria-hidden', 'true');
  map.getContainer().append(split);
  const clip = () => {
    const image = after.getElement();
    if (!image) return;
    const size = map.getSize();
    const northwest = map.latLngToContainerPoint(bounds.getNorthWest());
    const southeast = map.latLngToContainerPoint(bounds.getSouthEast());
    const left = Math.max(0, northwest.x);
    const right = Math.min(size.x, southeast.x);
    const divider = left + (right - left) * Number(slider.value) / 100;
    image.style.clipPath = `inset(0 0 0 ${Math.max(0, divider - northwest.x)}px)`;
    split.style.left = `${divider}px`;
    split.style.top = `${Math.max(0, northwest.y)}px`;
    split.style.bottom = `${Math.max(0, size.y - southeast.y)}px`;
    split.hidden = left >= right;
    slider.setAttribute('aria-valuetext', `${slider.value}% ширины — снимок до события`);
  };
  map.on('move zoom resize', clip);
  slider.addEventListener('input', clip);
  map.fitBounds(bounds, { maxZoom: 11 });
  map.setMaxBounds(bounds.pad(.2));
  new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer());
  clip();

  const scarLayer = L.geoJSON(scar, {
    pane: 'case-scar', style: { color: '#ffd267', fillColor: '#ff9130', weight: 1.6, fillOpacity: .28 },
    onEachFeature: (_, layer) => addPopup(layer, 'Вероятный след гари',
      'Выделен по изменению спектра на снимках Sentinel‑2. Причина горения неизвестна.'),
  });
  const parcelLayer = L.geoJSON(parcels, {
    pane: 'case-parcels',
    style: ({ properties }) => ({ color: properties.overlapKm2 > 0 ? '#78e3ff' : '#a6bac4',
      weight: properties.overlapKm2 > 0 ? 1.8 : 1, fill: false }),
    onEachFeature: ({ properties }, layer) => addPopup(layer, 'Участок ЕГКН',
      properties.overlapKm2 > 0 ? `Пересечение со следом ~${number.format(properties.overlapKm2)} км².` : 'Пересечения с выделенным следом нет.'),
  });
  const heatLayer = L.geoJSON(detections, {
    pointToLayer: (_, point) => L.circleMarker(point, { pane: 'case-detections',
      radius: 2.4, color: '#ff8f99', weight: 1, fillOpacity: .8 }),
    onEachFeature: ({ properties }, layer) =>
      addPopup(layer, 'NOAA‑20 / VIIRS', `12 апреля 2025 · ${properties.time} UTC`),
  });
  for (const [id, layer] of [['case-scar', scarLayer], ['case-parcels', parcelLayer], ['case-detections', heatLayer]]) {
    const control = byId(id);
    const change = () => { if (control.checked) layer.addTo(map); else layer.remove(); };
    control.addEventListener('change', change);
    change();
  }
  for (const image of [before, after]) image.on('error', () => {
    byId('case-result').textContent = 'Один из снимков Sentinel‑2 не загрузился. Обновите страницу.';
  });
}

const section = byId('kishkenekol-case');
const observer = new IntersectionObserver(([entry]) => {
  if (!entry.isIntersecting) return;
  observer.disconnect();
  renderCase().catch((error) => {
    byId('case-result').textContent = 'Не удалось загрузить сравнение снимков.';
    console.error(error);
  });
}, { rootMargin: '400px' });
observer.observe(section);

return { reveal() { if (byId('case-layout') && !byId('case-layout').hidden) window.dispatchEvent(new Event('resize')); } };
}
