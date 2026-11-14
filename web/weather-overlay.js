const fields = {
  temperature: { title: 'Макс. температура', unit: '°C', ticks: [-10, 0, 10, 20, 30, 40],
    colors: ['#5657c5', '#278bf1', '#22d2e2', '#6ce2a2', '#ffd16b', '#f47465'], index: 0 },
  rain: { title: 'Суточные осадки', unit: 'мм', ticks: [0, 1, 5, 10, 20, 40],
    colors: ['#112644', '#14629a', '#38bbec', '#51e5b2', '#ffd477', '#ef72bc'], index: 3 },
  cloud: { title: 'Средняя облачность', unit: '%', ticks: [0, 20, 40, 60, 80, 100],
    colors: ['#142644', '#31517b', '#517ca8', '#7da7cc', '#afd4eb', '#f4fbff'], index: 4 },
};
const palettes = Object.fromEntries(Object.entries(fields).map(([key, field]) => [
  key, field.colors.map((hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))),
]));
const measure = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
const radians = Math.PI / 180;
const radiusKm = 160;
const step = 6;

function weights(lat, lng, stations) {
  const longitudeScale = 111.2 * Math.cos(lat * radians);
  const nearest = stations.map(([y, x], index) => [
    index, ((x - lng) * longitudeScale) ** 2 + ((y - lat) * 111.2) ** 2,
  ]).filter(([, distance]) => distance <= radiusKm ** 2).sort((a, b) => a[1] - b[1]).slice(0, 4);
  if (!nearest.length) return null;
  if (nearest[0][1] < 0.0001) return [[nearest[0][0], 1]];
  const total = nearest.reduce((sum, [, distance]) => sum + 1 / distance, 0);
  return nearest.map(([index, distance]) => [index, 1 / (distance * total)]);
}

function weighted(entries, values, index) {
  return entries.reduce((sum, [station, weight]) => sum + values[station][index] * weight, 0);
}

function shade(field, value) {
  const ticks = fields[field].ticks;
  const colors = palettes[field];
  const next = ticks.findIndex((tick) => value < tick);
  if (next === 0) return colors[0];
  if (next < 0) return colors[colors.length - 1];
  const t = (value - ticks[next - 1]) / (ticks[next] - ticks[next - 1]);
  return colors[next - 1].map((channel, i) => channel * (1 - t) + colors[next][i] * t);
}

export function createWeatherOverlay(map, boundary, formatDate, scope = document) {
  const { type, coordinates } = boundary.geometry;
  const polygons = type === 'Polygon' ? [coordinates] : coordinates;
  const colorCanvas = document.createElement('canvas');
  const windCanvas = document.createElement('canvas');
  const buffer = document.createElement('canvas');
  const color = colorCanvas.getContext('2d');
  const wind = windCanvas.getContext('2d');
  const layer = map.createPane('weather-field');
  layer.style.zIndex = 410;
  layer.style.pointerEvents = 'none';
  const windPane = map.createPane('wind-flow');
  windPane.style.zIndex = 432;
  windPane.style.pointerEvents = 'none';
  colorCanvas.className = windCanvas.className = 'leaflet-layer weather-canvas';
  layer.append(colorCanvas);
  windPane.append(windCanvas);

  const key = scope.querySelector('#weather-key');
  const info = scope.querySelector('#weather-inspector');
  const status = scope.querySelector('#weather-state');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let current;
  let field = '';
  let flow = false;
  let grid;
  let stations;
  let selected;
  let pin;
  let frame;
  let paused = false;
  let time;
  let particles = [];
  let lastKey = '';

  function prepare() {
    const size = map.getSize();
    const { x: width, y: height } = size;
    const projected = polygons.map((polygon) => polygon.map((ring) => ring.map(([lon, lat]) =>
      map.latLngToContainerPoint([lat, lon]))));
    const points = projected.flat(2);
    const clamp = (value, max) => Math.max(0, Math.min(value, max));
    const left = clamp(Math.floor(Math.min(...points.map((p) => p.x))), width);
    const top = clamp(Math.floor(Math.min(...points.map((p) => p.y))), height);
    const right = clamp(Math.ceil(Math.max(...points.map((p) => p.x))), width);
    const bottom = clamp(Math.ceil(Math.max(...points.map((p) => p.y))), height);
    if (right <= left || bottom <= top) return undefined;
    const clip = new Path2D();
    for (const polygon of projected) {
      for (const ring of polygon) {
        clip.moveTo(ring[0].x, ring[0].y);
        for (const p of ring.slice(1)) clip.lineTo(p.x, p.y);
        clip.closePath();
      }
    }
    const cols = Math.ceil((right - left) / step);
    const rows = Math.ceil((bottom - top) / step);
    const values = Array.from({ length: cols * rows }, (_, i) => {
      const { lat, lng } = map.containerPointToLatLng([left + (i % cols + .5) * step,
        top + (Math.floor(i / cols) + .5) * step]);
      return weights(lat, lng, stations);
    });
    const origin = map.containerPointToLayerPoint([0, 0]);
    for (const canvas of [colorCanvas, windCanvas]) {
      L.DomUtil.setPosition(canvas, origin);
      canvas.width = width;
      canvas.height = height;
    }
    return { clip, left, top, right, bottom, cols, rows, values };
  }

  function drawField() {
    color.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
    if (!grid || !field) return;
    const { clip, left, top, cols, rows, values } = grid;
    buffer.width = cols;
    buffer.height = rows;
    const ctx = buffer.getContext('2d');
    const pixels = ctx.createImageData(cols, rows);
    values.forEach((entries, i) => {
      if (!entries) return;
      const value = weighted(entries, current.samples, fields[field].index);
      const rgb = shade(field, value);
      const opacity = field === 'rain' ? Math.min(162, value * 38)
        : field === 'cloud' ? 30 + value * 1.23 : 152;
      pixels.data.set([...rgb, opacity], i * 4);
    });
    ctx.putImageData(pixels, 0, 0);
    color.save();
    color.clip(clip, 'evenodd');
    color.drawImage(buffer, left, top, cols * step, rows * step);
    color.restore();
  }

  function projectWind() {
    if (!grid || !flow) return;
    const vectors = current.samples.map(([, speed, from]) =>
      [-Math.sin(from * radians) * speed, Math.cos(from * radians) * speed]);
    grid.vectors = grid.values.map((entries) =>
      entries && [weighted(entries, vectors, 0), weighted(entries, vectors, 1)]);
  }

  function vectorAt(x, y) {
    const col = Math.floor((x - grid.left) / step);
    const row = Math.floor((y - grid.top) / step);
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
    return grid.vectors[row * grid.cols + col];
  }

  function resetParticles() {
    if (!grid || !flow) return;
    const { left, top, right, bottom, clip } = grid;
    const area = (right - left) * (bottom - top);
    const count = Math.min(480, Math.max(52, area / 670));
    particles = [];
    for (let i = 0; i < count * 3 && particles.length < count; i++) {
      const x = left + Math.random() * (right - left);
      const y = top + Math.random() * (bottom - top);
      if (wind.isPointInPath(clip, x, y, 'evenodd') && vectorAt(x, y)) {
        particles.push({ x, y, originX: x, originY: y, phase: Math.random() });
      }
    }
  }

  function drawWind(elapsed, moving) {
    wind.clearRect(0, 0, windCanvas.width, windCanvas.height);
    if (!grid || !flow) return;
    wind.save();
    wind.clip(grid.clip, 'evenodd');
    wind.lineCap = 'round';
    wind.lineWidth = 1.15;
    for (const particle of particles) {
      const { x, y } = particle;
      const vector = vectorAt(x, y);
      const speed = vector && Math.hypot(...vector);
      if (speed) {
        const [dx, dy] = vector.map((component) => component / speed);
        const length = Math.min(24, 6 + speed * 2);
        wind.strokeStyle = `rgba(219,253,255,${moving ? .15 + .64 * Math.sin(particle.phase * Math.PI) : .72})`;
        wind.beginPath();
        wind.moveTo(x - dx * length, y - dy * length);
        wind.lineTo(x, y);
        if (!moving) {
          wind.lineTo(x - dx * 4 - dy * 2, y - dy * 4 + dx * 2);
          wind.moveTo(x, y);
          wind.lineTo(x - dx * 4 + dy * 2, y - dy * 4 - dx * 2);
        }
        wind.stroke();
        particle.x += dx * Math.min(58, 9 + speed * 5) * elapsed;
        particle.y += dy * Math.min(58, 9 + speed * 5) * elapsed;
      }
      particle.phase += elapsed * .36;
      if (!speed || particle.phase >= 1) {
        particle.x = particle.originX;
        particle.y = particle.originY;
        particle.phase = 0;
      }
    }
    wind.restore();
  }

  function animate(now) {
    if (paused || !grid || !flow || reducedMotion.matches) return;
    if (time === undefined || now - time >= 32) {
      drawWind(time === undefined ? 0 : Math.min(.08, (now - time) / 1000), true);
      time = now;
    }
    frame = requestAnimationFrame(animate);
  }

  function refresh(reproject = false) {
    cancelAnimationFrame(frame);
    time = undefined;
    if (!current) {
      color.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
      wind.clearRect(0, 0, windCanvas.width, windCanvas.height);
      grid = undefined;
      return;
    }
    if (reproject || !grid) {
      grid = prepare();
      particles = [];
    }
    drawField();
    projectWind();
    if (flow && grid && !particles.length) resetParticles();
    drawWind(0, !reducedMotion.matches);
    if (!paused && flow && grid && !reducedMotion.matches) frame = requestAnimationFrame(animate);
  }

  function updateInspector() {
    info.hidden = !current || !selected;
    pin?.remove();
    if (info.hidden) return;
    const { lat, lng } = selected;
    const entries = weights(lat, lng, stations);
    const point = map.latLngToContainerPoint(selected);
    if (!grid || !entries || !color.isPointInPath(grid.clip, point.x, point.y, 'evenodd')) {
      info.hidden = true;
      return;
    }
    const sample = (index) => measure.format(weighted(entries, current.samples, index));
    info.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `Оценка ERA5 · ${formatDate(current.date)}`;
    const values = document.createElement('span');
    values.textContent = `${measure.format(lat)}° с. ш. · ${measure.format(lng)}° в. д.`;
    const readings = document.createElement('span');
    readings.textContent = `${sample(0)} °C · ветер ${sample(1)} м/с · ${sample(3)} мм · облачность ${sample(4)}%`;
    info.append(title, values, readings);
    pin ??= L.circleMarker(selected, { pane: 'markerPane', radius: 6, weight: 2, color: '#fff',
      fillColor: '#07132d', fillOpacity: 1, interactive: false });
    pin.setLatLng(selected).addTo(map);
  }

  map.on('click', ({ latlng }) => { if (current) { selected = latlng; updateInspector(); } });
  map.on('moveend', () => { if (current) { refresh(true); updateInspector(); } });
  reducedMotion.addEventListener('change', () => refresh());

  return {
    pause() { paused = true; cancelAnimationFrame(frame); },
    resume() { paused = false; refresh(); },
    clear(message = '') {
      current = undefined;
      key.hidden = true;
      status.hidden = !message;
      status.textContent = message;
      refresh();
      updateInspector();
    },
    show(data, date, fieldName, showWind) {
      if (stations !== data.points) {
        stations = data.points;
        grid = undefined;
      }
      current = { date, samples: data.days[date] };
      field = fieldName;
      flow = showWind;
      key.hidden = !field;
      if (field && lastKey !== field) {
        lastKey = field;
        const spec = fields[field];
        const title = document.createElement('strong');
        title.textContent = `${spec.title} · ${spec.unit}`;
        const gradient = document.createElement('span');
        gradient.className = 'weather-gradient';
        const [min, max] = [spec.ticks[0], spec.ticks.at(-1)];
        gradient.style.background = `linear-gradient(90deg, ${spec.colors.map((c, i) =>
          `${c} ${100 * (spec.ticks[i] - min) / (max - min)}%`).join(', ')})`;
        const labels = document.createElement('span');
        labels.className = 'weather-scale';
        for (const tick of [min, spec.ticks[Math.floor(spec.ticks.length / 2)], max]) {
          const label = document.createElement('span');
          label.textContent = measure.format(tick);
          label.style.left = `${100 * (tick - min) / (max - min)}%`;
          labels.append(label);
        }
        key.replaceChildren(title, gradient, labels);
      }
      status.hidden = false;
      status.textContent = 'Интерполяция по 17 точкам ERA5. Нажмите на карту для значений.';
      refresh();
      updateInspector();
    },
  };
}
