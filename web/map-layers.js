const monthPath = (path, month, day) => path.replaceAll('{month}', month).replaceAll('{date}', day ?? '');

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

export async function createExtraLayers(map, controls, getJSON, onChange) {
  const manifest = await getJSON('data/layers.json?v=sko-layers');
  const cached = new Map();
  const groups = new Map();
  const layers = [];
  if (manifest.version !== 1 || !Array.isArray(manifest.layers)) throw new Error('Unsupported layer catalog');
  const pane = map.createPane('event-layers');
  pane.style.zIndex = 420;
  const renderer = L.canvas({ pane: 'event-layers' });
  for (const spec of manifest.layers) {
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
    input.addEventListener('change', () => onChange(input.checked && spec.url.includes('{date}')));
    label.append(input, document.createTextNode(spec.label));
    groups.get(spec.group).append(label);
    layers.push({ spec, input, shown: L.layerGroup().addTo(map), key: undefined });
  }
  let revision = 0;

  function load(path) {
    if (!cached.has(path)) {
      if (cached.size >= 24) cached.delete(cached.keys().next().value);
      cached.set(path, getJSON(path).catch((error) => {
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
      if (spec.range && (month < spec.range[0] || month > spec.range[1])) {
        shown.clearLayers();
        entry.key = undefined;
        return `${prefix} · архив для этой даты недоступен.`;
      }
      const path = monthPath(spec.url, month, date);
      if (spec.format === 'xyz') {
        if (spec.url.includes('{date}') && !date) {
          shown.clearLayers();
          entry.key = undefined;
          return `${prefix} · выберите день.`;
        }
        if (path !== entry.key) {
          shown.clearLayers();
          const tiles = L.tileLayer(/^https:\/\//.test(path) ? path : `data/${path}`, {
            maxNativeZoom: spec.maxNativeZoom ?? 8, maxZoom: map.getMaxZoom(), opacity: spec.opacity ?? .65,
            noWrap: true, pane: spec.underlay ? 'tilePane' : 'event-layers', zIndex: 4,
          });
          tiles.on('tileerror', () => {
            if (entry.key === path && input.checked) controls.dispatchEvent(new CustomEvent('layer-tile-error', { detail: spec.label }));
          });
          tiles.addTo(shown);
          entry.key = path;
        }
        return prefix;
      }
      shown.clearLayers();
      try {
        const dataset = await load(`data/${path}`);
        if (next !== revision) return null;
        const categories = spec.categories ?? (spec.category ? [spec.category] : null);
        const active = dataset.features.filter(({ properties }) =>
          (spec.static || !date || properties.date === date) && (!categories || categories.includes(properties.category)));
        const style = { renderer, pane: 'event-layers', color: spec.color,
          opacity: .95, weight: 1.2, fill: true, fillColor: spec.color, fillOpacity: .42 };
        if (active.length) {
          L.geoJSON(active, {
            ...style,
            style,
            pointToLayer: (feature, latlng) => L.circleMarker(latlng,
              { ...style, radius: 5, weight: 1.5, fillOpacity: .82 }),
            onEachFeature: (feature, layer) => layer.bindPopup(() => eventPopup(feature, spec)),
          }).addTo(shown);
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
