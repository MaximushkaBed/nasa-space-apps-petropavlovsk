import { loadGfsSurfaceTemp, sampleGrid, windArchiveStart } from './gfs-wind.js?v=surface-temperature';
import { temperatureColor } from './layer-values.js?v=atlas-polish';
const format = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });

export function createTemperatureBackground(map, caption, setBusy) {
  const pane = map.createPane('temperature-background');
  pane.style.zIndex = 403;
  pane.style.pointerEvents = 'none';
  const canvas = document.createElement('canvas');
  canvas.className = 'temperature-background';
  canvas.hidden = true;
  pane.append(canvas);
  const context = canvas.getContext('2d');
  const cache = new Map();
  let displayed;
  let requested;
  let generation = 0;

  function draw() {
    canvas.hidden = !displayed;
    if (!displayed) return;
    const { x: width, y: height } = map.getSize();
    if (!width || !height) return;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.ceil(width / 6);
    canvas.height = Math.ceil(height / 6);
    const pixels = context.createImageData(canvas.width, canvas.height);
    const longitudes = Array.from({ length: canvas.width }, (_, x) => map.containerPointToLatLng([x * 6, 0]).lng);
    for (let y = 0, i = 0; y < canvas.height; y++) {
      const { lat } = map.containerPointToLatLng([0, y * 6]);
      for (const lon of longitudes) {
        pixels.data.set(temperatureColor(sampleGrid(displayed.values, lat, lon)), i);
        pixels.data[i + 3] = 255;
        i += 4;
      }
    }
    context.putImageData(pixels, 0, 0);
  }

  function status(message = '') {
    caption.textContent = message;
    caption.hidden = !message;
  }

  map.on('moveend resize', draw);
  return {
    async show(day) {
      if (day === requested) return;
      requested = day;
      const revision = ++generation;
      displayed = undefined;
      draw();
      status();
      setBusy(false);
      if (!day) return;
      if (day < windArchiveStart) {
        status('Модельный фон NOAA GFS доступен с 23.03.2021.');
        return;
      }
      setBusy(true);
      try {
        if (!cache.has(day)) {
          cache.set(day, loadGfsSurfaceTemp(day, AbortSignal.timeout(10000)).catch(error => {
            cache.delete(day);
            throw error;
          }));
          if (cache.size > 6) cache.delete(cache.keys().next().value);
        }
        const grid = await cache.get(day);
        if (revision !== generation) return;
        displayed = grid;
        draw();
        status(grid ? `В пропусках — модель NOAA GFS · 1° · ${day} 00:00 UTC`
          : 'За эту дату модельного кадра NOAA GFS нет.');
      } catch {
        if (revision === generation) status('Модельный фон NOAA GFS не загрузился.');
      } finally {
        if (revision === generation) setBusy(false);
      }
    },
    inspect({ lat, lng }) {
      if (!displayed) return;
      const value = sampleGrid(displayed.values, lat, lng);
      return { label: 'Температура поверхности', value: `≈ ${format.format(value)} °C`,
        source: 'Модель NOAA GFS · 1°', date: `${displayed.day} 00:00 UTC` };
    },
  };
}
