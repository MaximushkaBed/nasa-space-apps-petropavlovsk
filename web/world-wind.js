import { loadGfsWind, sampleWind, windArchiveStart } from './gfs-wind.js?v=weather-motion';

const dayBefore = (day) => new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);

export function createWorldWind(map, status) {
  const pane = map.createPane('world-wind');
  pane.style.zIndex = 431;
  pane.style.pointerEvents = 'none';
  const canvas = document.createElement('canvas');
  canvas.className = 'world-wind-canvas';
  canvas.hidden = true;
  pane.append(canvas);
  const context = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const gridCache = new Map();
  let wind;
  let frame;
  let particles = [];
  let vectors = [];
  let columns;
  let width = 0, height = 0;
  let previous = 0;
  const spacing = 24;

  function cached(day) {
    if (!gridCache.has(day)) {
      if (gridCache.size >= 8) gridCache.delete(gridCache.keys().next().value);
      gridCache.set(day, loadGfsWind(day, AbortSignal.timeout(8500)).catch((error) => {
        gridCache.delete(day);
        throw error;
      }));
    }
    return gridCache.get(day);
  }

  function particle(x = Math.random() * width, y = Math.random() * height) {
    return { x, y, age: Math.random() * 85 };
  }

  function vectorAt(x, y) {
    const col = Math.floor(x / spacing), row = Math.floor(y / spacing);
    const i = row * columns + col;
    const fx = x / spacing - col, fy = y / spacing - row;
    const blend = (axis) => (vectors[i][axis] * (1 - fx) + vectors[i + 1][axis] * fx) * (1 - fy)
      + (vectors[i + columns][axis] * (1 - fx) + vectors[i + columns + 1][axis] * fx) * fy;
    return [blend(0), blend(1)];
  }

  function draw(time) {
    const dt = previous ? Math.min(32, time - previous) / 16.7 : 1;
    previous = time;
    context.clearRect(0, 0, width, height);
    const moving = !reduced.matches;
    for (const item of particles) {
      if (item.x < 0 || item.y < 0 || item.x >= width || item.y >= height || item.age > 85) Object.assign(item, particle(), { age: 0 });
      const [u, v] = vectorAt(item.x, item.y);
      const speed = Math.hypot(u, v);
      if (speed > .45) {
        const ux = u / speed, uy = v / speed;
        const length = Math.min(21, 5 + speed * 1.05);
        const fade = moving ? Math.min(1, item.age / 8, (86 - item.age) / 11) : 1;
        context.strokeStyle = `rgba(211,250,255,${fade * Math.min(.94, .52 + speed / 34)})`;
        context.beginPath();
        context.moveTo(item.x - ux * length, item.y - uy * length);
        context.lineTo(item.x, item.y);
        if (!moving) {
          context.lineTo(item.x - ux * 4 - uy * 2, item.y - uy * 4 + ux * 2);
          context.moveTo(item.x, item.y);
          context.lineTo(item.x - ux * 4 + uy * 2, item.y - uy * 4 - ux * 2);
        }
        context.stroke();
        const movement = Math.min(2.9, speed * .13 + .16) * dt;
        item.x += ux * movement;
        item.y += uy * movement;
      }
      item.age += dt;
    }
    if (moving) frame = requestAnimationFrame(draw);
  }

  function reset() {
    cancelAnimationFrame(frame);
    frame = undefined;
    previous = 0;
    canvas.hidden = !wind;
    if (!wind) return;
    ({ x: width, y: height } = map.getSize());
    if (!width || !height) return;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineWidth = 1.35;
    context.lineCap = 'round';
    columns = Math.ceil(width / spacing) + 1;
    const rows = Math.ceil(height / spacing) + 1;
    vectors = Array.from({ length: columns * rows }, (_, index) => {
      const { lat, lng } = map.containerPointToLatLng([(index % columns) * spacing, Math.floor(index / columns) * spacing]);
      const [u, v] = sampleWind(wind, lat, lng);
      return [u, -v];
    });
    particles = Array.from({ length: Math.min(1200, Math.max(100, Math.round(width * height / 1400))) }, () => particle());
    draw(performance.now());
  }

  function setStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  map.on('moveend resize', reset);
  reduced.addEventListener('change', reset);
  return {
    async prepare(day, previousDayAllowed) {
      if (day < windArchiveStart) return { message: `Архив потоков NOAA GFS доступен с ${windArchiveStart}.` };
      try {
        const prior = dayBefore(day);
        const grid = await cached(day) ?? (previousDayAllowed && prior >= windArchiveStart ? await cached(prior) : null);
        return grid ? {
          grid,
          message: `NOAA GFS · 10 м · 1° · ${grid.day}, 00:00 UTC${grid.day !== day ? ' · предыдущий кадр' : ''}`,
        } : { message: `В архиве NOAA GFS нет ветра за ${day} UTC.` };
      } catch {
        return { message: `Не удалось загрузить ветер NOAA GFS за ${day} UTC.` };
      }
    },
    display({ grid, message = '' } = {}) {
      if (wind !== grid) { wind = grid; reset(); }
      setStatus(message);
    },
    prefetch(day) { if (day >= windArchiveStart) cached(day).catch(() => {}); },
  };
}
