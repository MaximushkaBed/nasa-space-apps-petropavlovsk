import { createGibsDates } from './gibs-dates.js?v=world-layers';
import { colorKey, floodClasses, formatPixel, loadPalette, paletteLayers, temperatureBin, temperatureColor } from './layer-values.js?v=atlas-polish';
import { setLayerBusy } from './layer-status.js';

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

function inspectableTiles(url, options, layerId) {
  const layer = L.tileLayer(url, options);
  const read = document.createElement('canvas');
  read.width = read.height = 1;
  const probe = read.getContext('2d', { willReadFrequently: true });
  const original = new WeakMap();
  const flood = layerId === 'world-flood';
  const temperature = layerId === 'world-temperature';
  if (flood || temperature || layerId === 'world-clouds') layer.createTile = function (coords, done) {
    const tile = document.createElement('canvas');
    const finish = (error) => {
      if (tile.isConnected) done(error, tile);
    };
    tile.width = tile.height = 256;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => finish(new Error('NASA GIBS tile unavailable'));
    img.onload = async () => {
      try {
        const palette = await loadPalette(paletteLayers[layerId].palette);
        const context = tile.getContext('2d', { willReadFrequently: true });
        context.drawImage(img, 0, 0);
        const image = context.getImageData(0, 0, 256, 256);
        const pixels = image.data;
        const temperatureColors = new Map();
        for (let i = 0; i < pixels.length; i += 4) {
          if (!pixels[i + 3]) continue;
          const key = colorKey(pixels[i], pixels[i + 1], pixels[i + 2]);
          const values = palette.get(key);
          if (temperature) {
            if (!temperatureColors.has(key)) {
              const t = values?.size === 1 ? temperatureBin(values.values().next().value) : NaN;
              temperatureColors.set(key, Number.isFinite(t) ? temperatureColor(t) : null);
            }
            const color = temperatureColors.get(key);
            if (color) pixels.set(color, i);
            else pixels[i + 3] = 0;
            continue;
          }
          const value = values?.size === 1 ? Number(values.values().next().value) : NaN;
          if (flood) {
            const category = floodClasses[value];
            if (category) pixels.set(category.rgb, i);
            else pixels[i + 3] = 0;
            continue;
          }
          const cloud = Number.isFinite(value) ? value : 0;
          pixels[i] = 226;
          pixels[i + 1] = 239;
          pixels[i + 2] = 255;
          pixels[i + 3] = 255 * (cloud / 100) ** 1.55;
        }
        context.putImageData(image, 0, 0);
        original.set(tile, img);
        finish();
      } catch (error) { finish(error); }
    };
    tile.dataset.source = img.src = this.getTileUrl(coords);
    return tile;
  };
  layer.pixelAt = (point) => {
    const container = layer.getContainer();
    if (!container) return;
    for (const tile of container.querySelectorAll('.leaflet-tile-loaded')) {
      const box = tile.getBoundingClientRect();
      if (!box.width || point.x < box.left || point.x >= box.right || point.y < box.top || point.y >= box.bottom) continue;
      const image = original.get(tile) ?? tile;
      if (!image.naturalWidth) continue;
      const x = Math.floor((point.x - box.left) * image.naturalWidth / box.width);
      const y = Math.floor((point.y - box.top) * image.naturalHeight / box.height);
      probe.clearRect(0, 0, 1, 1);
      probe.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
      return a ? colorKey(r, g, b) : null;
    }
  };
  return layer;
}

function floodLegend() {
  const legend = document.createElement('div');
  legend.className = 'layer-caption flood-legend';
  for (const { label, rgb } of Object.values(floodClasses)) {
    const row = document.createElement('div');
    const swatch = document.createElement('span');
    swatch.style.color = `rgb(${rgb.join(',')})`;
    swatch.setAttribute('aria-hidden', 'true');
    swatch.textContent = '■ ';
    row.append(swatch, label);
    legend.append(row);
  }
  const coverage = document.createElement('div');
  coverage.textContent = 'Обычная вода и зоны с недостатком наблюдений прозрачны.';
  legend.append(coverage);
  return legend;
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
  const manifest = await getJSON('data/layers.json?v=atlas-polish');
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
    const status = document.createElement('p');
    status.className = 'layer-caption';
    status.setAttribute('role', 'status');
    status.hidden = true;
    group.append(status);
    if (spec.id === 'world-temperature') group.append(controls.parentElement.querySelector('#temperature-status'));
    const entry = { spec, input, status, shown: L.layerGroup().addTo(map), order: index + 1 };
    if (spec.id === 'world-flood') {
      const legend = floodLegend();
      legend.hidden = true;
      input.addEventListener('change', () => { legend.hidden = !input.checked; });
      group.append(legend);
    }
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
        if (spec.id === 'world-temperature') {
          map.getPane('temperature-background').style.opacity = slider.valueAsNumber / 100;
          return;
        }
        const active = entry.current ?? entry.shown.getLayers()[0];
        active?.setOpacity(slider.valueAsNumber / 100);
      });
    }
    layers.push(entry);
  }
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function busy(entry) {
    setLayerBusy(entry.input, entry.input.checked && Boolean(entry.request?.pending || entry.current?.isLoading()));
  }

  function issue(entry, message = '') {
    entry.status.textContent = message;
    entry.status.hidden = !message;
  }

  function clearRaster(entry) {
    entry.stopTransition?.();
    entry.shown.clearLayers();
    entry.current = entry.key = undefined;
  }

  function showRaster(entry, path, request) {
    if (entry.key === path) return Promise.resolve();
    entry.stopTransition?.();
    const { spec, shown, input } = entry;
    const previous = entry.current;
    const temperature = spec.id === 'world-temperature';
    const opacity = temperature ? 1 : entry.opacity.valueAsNumber / 100;
    const pane = temperature ? 'temperature-background' : spec.underlay ? 'observation-rasters' : 'event-layers';
    if (temperature) map.getPane(pane).style.opacity = entry.opacity.valueAsNumber / 100;
    const url = /^https:\/\//.test(path) ? path : `data/${path}`;
    const options = {
      maxNativeZoom: spec.maxNativeZoom ?? 8, maxZoom: map.getMaxZoom(), opacity: previous ? 0 : opacity,
      pane, zIndex: entry.order * 2 + 1,
      attribution: `<a href="${spec.sourceUrl}">${spec.source}</a>`,
    };
    const tiles = paletteLayers[spec.id] ? inspectableTiles(url, { ...options, crossOrigin: 'anonymous' }, spec.id)
      : L.tileLayer(url, options);
    tiles.on('loading load', () => {
      if (entry.current === tiles) busy(entry);
    });
    return new Promise((resolve) => {
      let loaded = 0, timeout;
      function finish(swap) {
        clearTimeout(timeout);
        tiles.off('load', ready);
        entry.stopTransition = undefined;
        if (swap && entry.request === request && input.checked) {
          entry.current = tiles;
          entry.key = path;
          if (previous && !reducedMotion.matches && tiles.getContainer()) {
            previous.getContainer()?.classList.add('weather-frame-fade');
            tiles.getContainer().classList.add('weather-frame-fade');
            previous.setOpacity(0);
            setTimeout(() => shown.removeLayer(previous), 210);
          } else if (previous) shown.removeLayer(previous);
          tiles.setOpacity(temperature ? 1 : entry.opacity.valueAsNumber / 100);
          tiles.setZIndex(entry.order * 2);
        } else queueMicrotask(() => shown.removeLayer(tiles));
        resolve();
      }
      const ready = () => finish(loaded > 0);
      entry.stopTransition = () => finish(false);
      tiles.on('tileload', () => { loaded++; });
      tiles.on('tileerror', () => {
        if (input.checked && (entry.request === request || entry.current === tiles)) issue(entry, 'Часть плиток недоступна.');
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

  async function loadLayer(entry, month, date, request) {
    const { spec, shown } = entry;
    const prefix = `${spec.label} · ${spec.source}`;
    try {
      if (spec.range && (month < spec.range[0] || (spec.range[1] && month > spec.range[1]))) {
        clearRaster(entry);
        issue(entry, 'Архив для этой даты недоступен.');
        return `${prefix} · архив для этой даты недоступен.`;
      }
      let path = spec.url.replaceAll('{month}', month).replaceAll('{date}', date);
      if (spec.format === 'xyz') {
        let dateLabel = '';
        const gibsPath = spec.maxLagDays !== undefined && path.match(/\/best\/([^/]+)\/default\/([^/]+)\//);
        if (gibsPath) {
          const [, layer, target] = gibsPath;
          const available = await gibsDate(layer, target, spec.maxLagDays);
          if (entry.request !== request) return null;
          if (!available.day) {
            clearRaster(entry);
            issue(entry, 'В архиве нет кадров на эту дату.');
            return `${prefix} · в архиве нет кадров для этой даты.`;
          }
          path = path.replace(`/default/${target}/`, `/default/${available.day}/`);
          const caption = spec.composite ? 'композит с' : spec.url.includes('{month}') ? 'данные за' : 'кадр от';
          const shownDate = spec.url.includes('{month}') ? available.day.slice(0, 7) : available.day;
          dateLabel = ` · ${caption} ${shownDate}${available.day < target && !spec.composite ? ' · ближайший предыдущий' : ''}`;
          if (!available.verified) dateLabel += ' · доступность даты не проверена';
        }
        await showRaster(entry, path, request);
        if (entry.request !== request) return null;
        if (entry.key !== path) {
          clearRaster(entry);
          issue(entry, 'Кадр не загрузился.');
          return `${prefix} · кадр не загрузился.`;
        }
        return prefix + dateLabel;
      }
      const dataset = await load(`data/${path}`, spec, month);
      if (entry.request !== request) return null;
      shown.clearLayers();
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
            onEachFeature: (feature, layer) => {
              layer.bindPopup(() => eventPopup(feature, spec));
              layer.bindTooltip(() => {
                const caption = document.createElement('span');
                caption.textContent = `${feature.properties.name || spec.label} · ${feature.properties.date ?? date}`;
                return caption;
              });
            },
          }).addTo(shown);
        }
      }
      if (spec.coverage === 'observations') {
        const observations = dataset.observations ?? {};
        if (!date) return `${prefix} · охват по ${Object.keys(observations).length} датам, затопления на ${active.length} датах.`;
        if (!observations[date]) {
          issue(entry, 'Нет наблюдений за этот день.');
          return `${prefix} · за этот день нет покрытия.`;
        }
        const [value, coverage] = observations[date];
        return `${prefix} · ${value.toLocaleString('ru', { maximumFractionDigits: 2 })}% обследованных ячеек с сигналом затопления, охват СКО ${coverage.toLocaleString('ru', { maximumFractionDigits: 1 })}%.`;
      }
      const records = new Set(active.map(({ properties }) => properties.id)).size;
      return `${prefix} · ${records ? `записей о событиях — ${records}` : 'в каталоге за период записей нет'}.`;
    } catch (error) {
      if (entry.request !== request) return null;
      issue(entry, 'Слой не загрузился.');
      console.error(error);
      return `${prefix} · слой не загрузился.`;
    } finally {
      if (entry.request === request) {
        request.pending = false;
        if (entry.status.textContent && !entry.current) entry.request = undefined;
        busy(entry);
      }
    }
  }

  function render(month, date) {
    return Promise.all(layers.map((entry) => {
      if (!entry.input.checked || entry.input.closest('fieldset').hidden) {
        entry.request = undefined;
        clearRaster(entry);
        issue(entry);
        busy(entry);
        return null;
      }
      if (entry.request?.date === date) return entry.request.promise;
      const request = { date, pending: true };
      entry.request = request;
      entry.stopTransition?.();
      if (entry.spec.id === 'world-temperature') {
        clearRaster(entry);
        map.getPane('temperature-background').style.opacity = entry.opacity.valueAsNumber / 100;
      }
      issue(entry);
      busy(entry);
      request.promise = loadLayer(entry, month, date, request);
      return request.promise;
    }));
  }

  render.inspect = async ({ originalEvent }) => {
    if (!originalEvent) return [];
    const point = { x: originalEvent.clientX, y: originalEvent.clientY };
    return Promise.all(layers.map(async ({ spec, input, current, key }) => {
      const palette = paletteLayers[spec.id];
      if (!palette || !input.checked || input.closest('fieldset').hidden || !current?.pixelAt) return;
      const date = key.match(/\/default\/(\d{4}-\d{2}-\d{2})\//)?.[1];
      const shownDate = spec.composite ? `Композит с ${date}` : spec.id === 'world-wind' ? date?.slice(0, 7) : date;
      const result = { id: spec.id, label: spec.label, source: spec.source, date: shownDate };
      try {
        const pixel = current.pixelAt(point);
        if (pixel === undefined) return;
        if (pixel === null) {
          return { ...result, missing: true, value: spec.id === 'world-temperature' ? 'Спутникового измерения нет' : 'Нет данных в пикселе' };
        }
        const colors = await loadPalette(palette.palette);
        const values = colors.get(pixel);
        if (spec.id === 'world-temperature' && (values?.size !== 1 || !Number.isFinite(temperatureBin(values.values().next().value)))) {
          return { ...result, missing: true, value: 'Спутникового измерения нет' };
        }
        return { ...result, value: formatPixel(values, palette) };
      } catch {
        return { ...result, missing: true, value: 'Не удалось прочитать значение' };
      }
    }));
  };
  return render;
}
