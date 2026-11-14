const paletteHost = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/';
export const paletteLayers = {
  'world-temperature': { palette: 'MODIS_Land_Surface_Temp', unit: '°C', offset: -273.15, decimals: 1 },
  'world-precip': { palette: 'GPM_Precipitation_Rate', unit: 'мм/ч', decimals: 4 },
  'world-clouds': { palette: 'MODIS_Cloud_Fraction', unit: '%', decimals: 0 },
  'world-wind': { palette: 'MERRA2_Surface_Wind_Speed_Monthly', unit: 'м/с', decimals: 1 },
  'world-ndvi': { palette: 'MODIS_L3_NDVI', decimals: 3 },
  'world-flood': { palette: 'MODIS_Flood', classes: {
    1: 'Поверхностная вода', 2: 'Повторяющееся затопление', 3: 'Затопление', 255: 'Недостаточно наблюдений',
  } },
};
const palettes = new Map();
export const colorKey = (r, g, b) => (r << 16) | (g << 8) | b;

export function loadPalette(name) {
  if (!palettes.has(name)) {
    palettes.set(name, fetch(`${paletteHost}${name}.xml`, { signal: AbortSignal.timeout(7500) }).then(async response => {
      if (!response.ok) throw new Error('NASA GIBS colormap unavailable');
      const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
      const entries = [...xml.querySelectorAll('ColorMapEntry[transparent="false"]')];
      if (!entries.length) throw new Error('Invalid GIBS colormap');
      const colors = new Map();
      for (const entry of entries) {
        const value = entry.getAttribute('value') ?? entry.getAttribute('sourceValue');
        if (!value) continue;
        const key = colorKey(...entry.getAttribute('rgb').split(',').map(Number));
        if (!colors.has(key)) colors.set(key, new Set());
        colors.get(key).add(value);
      }
      return colors;
    }).catch(error => { palettes.delete(name); throw error; }));
  }
  return palettes.get(name);
}

export function formatPixel(values, spec) {
  if (!values || values.size !== 1) return 'Нет однозначного значения';
  const [value] = values;
  if (spec.classes) return spec.classes[value] ?? 'Нет данных';
  const unit = spec.unit ? ` ${spec.unit}` : '';
  const format = new Intl.NumberFormat('ru', { maximumFractionDigits: spec.decimals });
  const converted = n => format.format(Number(n) + (spec.offset ?? 0));
  const range = value.match(/^[[\(]([^,]+),([^\])]+)[\])]$/);
  if (!range) return Number.isFinite(Number(value)) ? `${converted(value)}${unit}` : 'Нет данных';
  const [, low, high] = range;
  if (low === '-INF') return `< ${converted(high)}${unit}`;
  if (high === 'INF' || high === '+INF') return `≥ ${converted(low)}${unit}`;
  const first = converted(low), last = converted(high);
  return first === last ? `≈ ${first}${unit}` : `${first}–${last}${unit}`;
}

export function createLayerReadout(map, panel, source, allowed) {
  let revision = 0;
  let mouseTimer;

  function clear() {
    ++revision;
    clearTimeout(mouseTimer);
    panel.hidden = true;
  }

  async function show(event) {
    const token = ++revision;
    if (!allowed(event.latlng)) return clear();
    const items = await source(event).catch(() => []);
    if (token !== revision) return;
    panel.replaceChildren(...items.filter(Boolean).map(item => {
      const row = document.createElement('div');
      const value = document.createElement('strong');
      value.textContent = `${item.label} · ${item.value}`;
      const metadata = document.createElement('small');
      metadata.textContent = [item.source, item.date].filter(Boolean).join(' · ');
      row.append(value, metadata);
      return row;
    }));
    panel.hidden = !panel.childElementCount;
  }

  map.on('mousemove', event => {
    clearTimeout(mouseTimer);
    ++revision;
    mouseTimer = setTimeout(() => show(event), 110);
  });
  map.on('click', show);
  map.on('mouseout movestart zoomstart', clear);
  return clear;
}
