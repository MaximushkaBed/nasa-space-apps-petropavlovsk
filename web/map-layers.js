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

let cloudPalette;
function cloudTileLayer(url, options) {
  const layer = L.tileLayer(url, options);
  layer.createTile = function (coords, done) {
    const tile = document.createElement('canvas');
    const finish = (error) => {
      if (tile.isConnected) done(error, tile);
    };
    tile.width = tile.height = 256;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => finish(new Error('NASA cloud tile unavailable'));
    img.onload = async () => {
      try {
        cloudPalette ??= fetch('https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_Cloud_Fraction.xml', {
          signal: AbortSignal.timeout(5000),
        }).then(async (response) => {
          if (!response.ok) throw new Error('NASA cloud palette unavailable');
          const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
          const entries = [...xml.querySelectorAll('ColorMapEntry[transparent="false"]')];
          if (!entries.length) throw new Error('NASA cloud palette empty');
          return new Map(entries.map((entry) => [entry.getAttribute('rgb').split(',').reduce((key, value) => key * 256 + Number(value), 0),
            Number(entry.getAttribute('value'))]));
        }).catch((error) => { cloudPalette = undefined; throw error; });
        const palette = await cloudPalette;
        const context = tile.getContext('2d', { willReadFrequently: true });
        context.drawImage(img, 0, 0);
        const image = context.getImageData(0, 0, 256, 256);
        const pixels = image.data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (!pixels[i + 3]) continue;
          const cloud = palette.get((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]) ?? 0;
          pixels[i] = 226;
          pixels[i + 1] = 239;
          pixels[i + 2] = 255;
          pixels[i + 3] = 255 * (cloud / 100) ** 1.55;
        }
        context.putImageData(image, 0, 0);
        finish();
      } catch (error) { finish(error); }
    };
    tile.dataset.source = img.src = this.getTileUrl(coords);
    return tile;
  };
  return layer;
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
  const manifest = await getJSON('data/layers.json?v=weather-motion');
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
      if (spec.id === 'gfm') group.dataset.skoLayer = '';
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
      slider.addEventListener('input', () => {
        const active = entry.current ?? entry.shown.getLayers()[0];
        active?.setOpacity(slider.valueAsNumber / 100);
      });
    }
    layers.push(entry);
  }
  let revision = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function clearRaster(entry) {
    entry.stopTransition?.();
    entry.shown.clearLayers();
    entry.current = entry.key = undefined;
  }

  function showRaster(entry, path, next) {
    if (entry.key === path) return Promise.resolve();
    entry.stopTransition?.();
    const { spec, shown, input } = entry;
    const previous = entry.current;
    const opacity = entry.opacity.valueAsNumber / 100;
    const tileLayer = spec.id === 'world-clouds' ? cloudTileLayer : L.tileLayer;
    const tiles = tileLayer(/^https:\/\//.test(path) ? path : `data/${path}`, {
      maxNativeZoom: spec.maxNativeZoom ?? 8, maxZoom: map.getMaxZoom(), opacity: previous ? 0 : opacity,
      pane: spec.underlay ? 'observation-rasters' : 'event-layers', zIndex: entry.order * 2 + 1,
      attribution: `<a href="${spec.sourceUrl}">${spec.source}</a>`,
    });
    return new Promise((resolve) => {
      let loaded = 0, timeout;
      function finish(swap) {
        clearTimeout(timeout);
        tiles.off('load', ready);
        entry.stopTransition = undefined;
        if (swap && next === revision && input.checked) {
          entry.current = tiles;
          entry.key = path;
          if (previous && !reducedMotion.matches && tiles.getContainer()) {
            previous.getContainer()?.classList.add('weather-frame-fade');
            tiles.getContainer().classList.add('weather-frame-fade');
            previous.setOpacity(0);
            setTimeout(() => shown.removeLayer(previous), 210);
          } else if (previous) shown.removeLayer(previous);
          tiles.setOpacity(entry.opacity.valueAsNumber / 100);
          tiles.setZIndex(entry.order * 2);
        } else queueMicrotask(() => shown.removeLayer(tiles));
        resolve();
      }
      const ready = () => finish(loaded > 0);
      entry.stopTransition = () => finish(false);
      tiles.on('tileload', () => { loaded++; });
      tiles.on('tileerror', () => {
        if (next === revision && input.checked) controls.dispatchEvent(new CustomEvent('layer-tile-error', { detail: spec.label }));
      });
      tiles.once('load', ready);
      timeout = setTimeout(ready, 4500);
      tiles.addTo(shown);
      if (!tiles.isLoading()) ready();
    });
  }

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
      if (!input.checked || input.closest('fieldset').hidden) {
        clearRaster(entry);
        return null;
      }
      const prefix = `${spec.label} · ${spec.source}`;
      if (spec.range && (month < spec.range[0] || (spec.range[1] && month > spec.range[1]))) {
        clearRaster(entry);
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
            clearRaster(entry);
            return `${prefix} · в архиве нет кадров для этой даты.`;
          }
          path = path.replace(`/default/${target}/`, `/default/${available.day}/`);
          const caption = spec.composite ? 'композит с' : spec.url.includes('{month}') ? 'данные за' : 'кадр от';
          const shownDate = spec.url.includes('{month}') ? available.day.slice(0, 7) : available.day;
          dateLabel = ` · ${caption} ${shownDate}${available.day < target && !spec.composite ? ' · ближайший предыдущий' : ''}`;
          if (!available.verified) dateLabel += ' · доступность даты не проверена';
        }
        await showRaster(entry, path, next);
        if (next !== revision) return null;
        if (entry.key !== path) {
          clearRaster(entry);
          return `${prefix} · кадр не загрузился.`;
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
