import { createGibsDates } from './gibs-dates.js?v=world-layers';

function externalLink(url, label) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') return document.createTextNode(label);
    const link = document.createElement('a');
    link.href = target.href;
    link.textContent = label;
    link.target = '_blank';
    link.rel = 'noreferrer';
    return link;
  } catch {
    return document.createTextNode(label);
  }
}

function eventPopup(feature, spec) {
  const { name, date, sourceUrl, value, coverage } = feature.properties;
  const root = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = name || spec.label;
  root.append(title, document.createElement('br'), document.createTextNode(date ? `${date} · ${spec.label}` : spec.label));
  if (Number.isFinite(value) && Number.isFinite(coverage)) {
    root.append(document.createElement('br'),
      document.createTextNode(`${value}% обследованных ячеек с сигналом затопления · охват СКО ${coverage}%`));
  }
  root.append(document.createElement('br'), externalLink(sourceUrl || spec.sourceUrl, spec.source));
  return root;
}

async function fetchEventMonth(feed, month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = `${month}-${new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()}`;
  const nasa = feed === 'eonet';
  const url = nasa ? new URL('https://eonet.gsfc.nasa.gov/api/v3/events')
    : new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
  url.search = new URLSearchParams(nasa ? { status: 'all', start: first, end: last, limit: 3000 }
    : { format: 'geojson', starttime: first, endtime: `${last}T23:59:59.999Z`, minmagnitude: 5.5, eventtype: 'earthquake' });
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${feed}`);
  const data = await response.json();
  return nasa ? data.events.flatMap((event) => event.geometry.flatMap(({ type, coordinates, date }) =>
    event.categories.map(({ id: category }) => ({ type: 'Feature', geometry: { type, coordinates },
      properties: { date: date.slice(0, 10), category, id: event.id, name: event.title, sourceUrl: event.link } }))))
    : data.features.filter((event) => event.geometry?.type === 'Point').map(({ id, geometry, properties }) => ({
      type: 'Feature', geometry,
      properties: { date: new Date(properties.time).toISOString().slice(0, 10), id, name: properties.title, sourceUrl: properties.url },
    }));
}

export async function createExtraLayers(map, controls, getJSON, onChange) {
  const manifest = await getJSON('data/layers.json?v=world-layers');
  const cached = new Map();
  const groups = new Map();
  const layers = [];
  const gibsDate = createGibsDates();
  if (manifest.version !== 1 || !Array.isArray(manifest.layers)) throw new Error('Unsupported layer catalog');
  const pane = map.createPane('event-layers');
  pane.style.zIndex = 420;
  const rasterPane = map.createPane('observation-rasters');
  rasterPane.style.zIndex = 403;
  rasterPane.style.pointerEvents = 'none';
  const renderer = L.canvas({ pane: 'event-layers' });
  for (const [index, spec] of manifest.layers.entries()) {
    if (!['geojson', 'xyz'].includes(spec.format)) throw new Error(`Unsupported map layer: ${spec.id}`);
    if (!groups.has(spec.group)) {
      const group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = spec.group;
      group.append(legend);
      groups.set(spec.group, group);
      controls.append(group);
    }
    const label = document.createElement('label');
    label.style.setProperty('--layer-color', spec.color);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `overlay-${spec.id}`;
    input.addEventListener('change', onChange);
    label.append(input, document.createTextNode(spec.label));
    const group = groups.get(spec.group);
    group.append(label);
    const entry = { spec, input, shown: L.layerGroup().addTo(map), key: undefined, order: index + 1 };
    if (spec.format === 'xyz') {
      const strength = document.createElement('label');
      strength.className = 'raster-opacity';
      strength.hidden = true;
      const slider = Object.assign(document.createElement('input'), {
        type: 'range', min: '10', max: '100', value: String((spec.opacity ?? .65) * 100),
      });
      slider.setAttribute('aria-label', `Прозрачность · ${spec.label}`);
      strength.append('Непрозрачность', slider);
      group.append(strength);
      entry.opacity = slider;
      input.addEventListener('change', () => { strength.hidden = !input.checked; });
      slider.addEventListener('input', () => entry.shown.eachLayer((tile) => tile.setOpacity(slider.valueAsNumber / 100)));
    }
    layers.push(entry);
  }
  let revision = 0;

  function load(path, spec, month) {
    if (!cached.has(path)) {
      if (cached.size >= 24) cached.delete(cached.keys().next().value);
      const seasonalSnapshot = month >= '2020-04' && month <= '2025-10' && +month.slice(5) >= 4 && +month.slice(5) <= 10;
      const dataset = spec.eventFeed && !seasonalSnapshot ? fetchEventMonth(spec.eventFeed, month)
        : getJSON(path).then((payload) => spec.eventFeed ? payload.features : payload);
      cached.set(path, dataset.catch((error) => {
        cached.delete(path);
        throw error;
      }));
    }
    return cached.get(path);
  }

  return async function render(month, date) {
    const next = ++revision;
    return Promise.all(layers.map(async (entry) => {
      const { spec, input, shown } = entry;
      if (!input.checked) {
        shown.clearLayers();
        entry.key = undefined;
        return null;
      }
      const prefix = `${spec.label} · ${spec.source}`;
      if (spec.range && (month < spec.range[0] || (spec.range[1] && month > spec.range[1]))) {
        shown.clearLayers();
        entry.key = undefined;
        return `${prefix} · архив для этой даты недоступен.`;
      }
      let path = spec.url.replaceAll('{month}', month).replaceAll('{date}', date);
      if (spec.format === 'xyz') {
        let dateLabel = '';
        const gibsPath = spec.maxLagDays !== undefined && path.match(/\/best\/([^/]+)\/default\/([^/]+)\//);
        if (gibsPath) {
          const [, layer, target] = gibsPath;
          const available = await gibsDate(layer, target, spec.maxLagDays);
          if (next !== revision) return null;
          if (!available.day) {
            shown.clearLayers();
            entry.key = undefined;
            return `${prefix} · в архиве нет кадров для этой даты.`;
          }
          path = path.replace(`/default/${target}/`, `/default/${available.day}/`);
          const caption = spec.composite ? 'композит с' : spec.url.includes('{month}') ? 'данные за' : 'кадр от';
          const shownDate = spec.url.includes('{month}') ? available.day.slice(0, 7) : available.day;
          dateLabel = ` · ${caption} ${shownDate}${available.day < target && !spec.composite ? ' · ближайший предыдущий' : ''}`;
          if (!available.verified) dateLabel += ' · доступность даты не проверена';
        }
        if (path !== entry.key) {
          shown.clearLayers();
          const tiles = L.tileLayer(/^https:\/\//.test(path) ? path : `data/${path}`, {
            maxNativeZoom: spec.maxNativeZoom ?? 8, maxZoom: map.getMaxZoom(), opacity: entry.opacity.valueAsNumber / 100,
            pane: spec.underlay ? 'observation-rasters' : 'event-layers', zIndex: entry.order,
            attribution: `<a href="${spec.sourceUrl}">${spec.source}</a>`,
          });
          tiles.on('tileerror', () => {
            if (entry.key === path && input.checked) controls.dispatchEvent(new CustomEvent('layer-tile-error', { detail: spec.label }));
          });
          tiles.addTo(shown);
          entry.key = path;
        }
        return prefix + dateLabel;
      }
      shown.clearLayers();
      try {
        const dataset = await load(`data/${path}`, spec, month);
        if (next !== revision) return null;
        const categories = spec.categories ?? (spec.category ? [spec.category] : null);
        const active = (spec.eventFeed ? dataset : dataset.features).filter(({ properties }) =>
          (spec.static || !date || properties.date === date) && (!categories || categories.includes(properties.category)));
        const style = { renderer, pane: 'event-layers', color: spec.color,
          opacity: .95, weight: 1.2, fill: true, fillColor: spec.color, fillOpacity: .42 };
        if (active.length) {
          for (const offset of spec.eventFeed ? [-360, 0, 360] : [0]) {
            L.geoJSON(active, {
              ...style, style,
              coordsToLatLng: ([lon, lat]) => L.latLng(lat, lon + offset),
              pointToLayer: (feature, latlng) => L.circleMarker(latlng,
                { ...style, radius: 5, weight: 1.5, fillOpacity: .82 }),
              onEachFeature: (feature, layer) => layer.bindPopup(() => eventPopup(feature, spec)),
            }).addTo(shown);
          }
        }
        if (spec.coverage === 'observations') {
          const observations = dataset.observations ?? {};
          if (!date) return `${prefix} · охват по ${Object.keys(observations).length} датам, затопления на ${active.length} датах.`;
          if (!observations[date]) return `${prefix} · за этот день нет покрытия.`;
          const [value, coverage] = observations[date];
          return `${prefix} · ${value.toLocaleString('ru', { maximumFractionDigits: 2 })}% обследованных ячеек с сигналом затопления, охват СКО ${coverage.toLocaleString('ru', { maximumFractionDigits: 1 })}%.`;
        }
        const records = new Set(active.map(({ properties }) => properties.id)).size;
        return `${prefix} · ${records ? `записей о событиях — ${records}` : 'в каталоге за период записей нет'}.`;
      } catch (error) {
        if (next !== revision) return null;
        console.error(error);
        return `${prefix} · слой не загрузился.`;
      }
    }));
  };
}
