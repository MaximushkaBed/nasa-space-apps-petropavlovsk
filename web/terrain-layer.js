import { numberFormat } from './i18n.js';
const source = 'Mapzen Terrain Tiles';
const sourceUrl = 'https://registry.opendata.aws/terrain-tiles/';
const palette = [
  [-1000, [31, 63, 121], '−1 000 м'],
  [0, [44, 129, 219], '0 м'],
  [250, [84, 175, 185], '250 м'],
  [1000, [230, 191, 101], '1 000 м'],
  [2500, [239, 122, 78], '2 500 м'],
  [5000, [190, 44, 57], '5 000+ м'],
];
const format = numberFormat({ maximumFractionDigits: 0 });

function elevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

function shade(pixels) {
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const height = elevation(pixels[i], pixels[i + 1], pixels[i + 2]);
    let next = 1;
    while (next < palette.length - 1 && height > palette[next][0]) next++;
    const [low, start] = palette[next - 1];
    const [high, end] = palette[next];
    const mix = Math.max(0, Math.min(1, (height - low) / (high - low)));
    for (let channel = 0; channel < 3; channel++) {
      pixels[i + channel] = start[channel] + (end[channel] - start[channel]) * mix;
    }
    // Keep the basemap recognizable under deep-ocean bathymetry.
    if (height < -100) pixels[i + 3] *= Math.max(.35, (height + 1000) / 900);
  }
}

function terrainLegend() {
  const legend = document.createElement('div');
  legend.className = 'weather-key terrain-key';
  const title = document.createElement('strong');
  title.textContent = 'Высота относительно уровня моря';
  const gradient = document.createElement('span');
  gradient.className = 'weather-gradient';
  gradient.style.background = `linear-gradient(90deg,${palette.map(([, rgb]) => `rgb(${rgb.join(',')})`).join(',')})`;
  const ticks = document.createElement('span');
  ticks.className = 'weather-scale';
  for (const index of [0, 1, 3, 5]) {
    const label = document.createElement('span');
    label.style.left = `${(index / (palette.length - 1)) * 100}%`;
    label.textContent = palette[index][2];
    ticks.append(label);
  }
  legend.append(title, gradient, ticks);
  return legend;
}

export function addTerrainControl(map, byId) {
  const pane = map.createPane('terrain-shading');
  pane.style.zIndex = 405;
  pane.style.pointerEvents = 'none';
  const toggle = byId('terrain-layer');
  const label = toggle.closest('label');
  const opacity = byId('terrain-opacity');
  const strength = opacity.closest('label');
  const status = byId('terrain-status');
  const legend = terrainLegend();
  status.before(legend);
  const spinner = document.createElement('span');
  spinner.className = 'fire-loading-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  label.append(spinner);

  const original = new WeakMap();
  const pending = new WeakMap();
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const sampler = probe.getContext('2d', { willReadFrequently: true });
  const tiles = L.tileLayer('https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png', {
    pane: 'terrain-shading', maxNativeZoom: 12, maxZoom: map.getMaxZoom(),
    opacity: opacity.valueAsNumber / 100,
    attribution: `<a href="${sourceUrl}">${source}</a> · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">источники высот</a>`,
  });
  tiles.createTile = function (coords, done) {
    const tile = document.createElement('canvas');
    tile.className = 'terrain-tile';
    tile.width = tile.height = this.getTileSize().x;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const stop = () => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      pending.delete(tile);
    };
    const finish = (error) => {
      stop();
      if (tile.isConnected) done(error, tile);
    };
    image.onerror = () => finish(new Error('Terrain tile unavailable'));
    image.onload = () => {
      if (!tile.isConnected) return stop();
      try {
        const context = tile.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, tile.width, tile.height);
        const data = context.getImageData(0, 0, tile.width, tile.height);
        shade(data.data);
        context.putImageData(data, 0, 0);
        original.set(tile, image);
        finish();
      } catch (error) {
        finish(error);
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error('Terrain tile timed out'));
      image.removeAttribute('src');
    }, 12000);
    pending.set(tile, () => {
      stop();
      image.removeAttribute('src');
    });
    image.src = this.getTileUrl(coords);
    return tile;
  };

  function loading(busy) {
    spinner.hidden = !busy;
    label.setAttribute('aria-busy', String(busy));
  }

  const visible = () => toggle.checked && map.hasLayer(tiles);
  tiles.on('loading', () => { status.hidden = true; loading(true); });
  tiles.on('tileerror', () => { if (visible()) status.hidden = false; });
  tiles.on('tileunload', ({ tile }) => pending.get(tile)?.());
  tiles.on('load', () => loading(false));
  function show() {
    strength.hidden = legend.hidden = !toggle.checked;
    if (toggle.checked) {
      status.hidden = true;
      tiles.addTo(map);
      loading(tiles.isLoading());
    }
    else {
      tiles.remove();
      loading(false);
      status.hidden = true;
    }
  }
  toggle.addEventListener('change', show);
  opacity.addEventListener('input', () => tiles.setOpacity(opacity.valueAsNumber / 100));
  byId('terrain-controls').disabled = false;
  show();

  return {
    visible,
    inspect(latlng) {
      if (!visible()) return;
      const container = map.getContainer().getBoundingClientRect();
      const position = map.latLngToContainerPoint(latlng);
      const x = container.left + position.x;
      const y = container.top + position.y;
      const candidates = tiles.getContainer()?.querySelectorAll('.leaflet-tile-loaded') ?? [];
      for (const tile of candidates) {
        const image = original.get(tile);
        if (!image) continue;
        const box = tile.getBoundingClientRect();
        if (!box.width || x < box.left || x >= box.right || y < box.top || y >= box.bottom) continue;
        const sx = Math.floor((x - box.left) * image.naturalWidth / box.width);
        const sy = Math.floor((y - box.top) * image.naturalHeight / box.height);
        sampler.clearRect(0, 0, 1, 1);
        sampler.drawImage(image, sx, sy, 1, 1, 0, 0, 1, 1);
        const [r, g, b, a] = sampler.getImageData(0, 0, 1, 1).data;
        if (a) return { label: 'Высота рельефа', value: `${format.format(elevation(r, g, b))} м`, source };
      }
    },
  };
}
