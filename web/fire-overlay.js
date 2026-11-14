export function createFireOverlay(map, platformNames, number) {
  const canvas = L.DomUtil.create('canvas', 'fire-canvas', map.getPane('activity-cells'));
  const heat = document.createElement('canvas');
  const dot = document.createElement('canvas');
  dot.width = dot.height = 48;
  const stamp = dot.getContext('2d');
  const glow = stamp.createRadialGradient(24, 24, 0, 24, 24, 24);
  glow.addColorStop(0, '#000');
  glow.addColorStop(1, '#0000');
  stamp.fillStyle = glow;
  stamp.fillRect(0, 0, 48, 48);

  const ramp = document.createElement('canvas');
  ramp.width = 256;
  ramp.height = 1;
  const colors = ramp.getContext('2d');
  const gradient = colors.createLinearGradient(0, 0, 256, 0);
  for (const [stop, color] of [[0, '#ff962d'], [.45, '#f44918'], [.78, '#ffbc36'], [1, '#fff288']]) {
    gradient.addColorStop(stop, color);
  }
  colors.fillStyle = gradient;
  colors.fillRect(0, 0, 256, 1);
  const palette = colors.getImageData(0, 0, 256, 1).data;
  const mercatorPoints = (data) => data.map(([lon, lat, platform, weight = 1]) => {
    const point = map.project([lat, lon], 0);
    return { lon, lat, platform, weight, x: point.x, y: point.y };
  });
  let points = [];
  let mode = 'points';
  let bins = new Map();
  let interactive = false;
  let input;

  function drawHeat(ctx, width, height, ratio) {
    const scale = Math.min(ratio, 1, 1400 / Math.max(width, height));
    heat.width = Math.ceil(width * scale);
    heat.height = Math.ceil(height * scale);
    const surface = heat.getContext('2d', { willReadFrequently: true });
    surface.setTransform(scale, 0, 0, scale, 0, 0);
    const radius = map.getZoom() < 6 ? 17 : 23;
    for (const { x, y, count } of bins.values()) {
      surface.globalAlpha = Math.min(.65, .025 + .045 * Math.log2(count + 1));
      surface.drawImage(dot, x - radius, y - radius, 2 * radius, 2 * radius);
    }
    const image = surface.getImageData(0, 0, heat.width, heat.height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (!alpha) continue;
      const color = alpha * 4;
      data[i] = palette[color];
      data[i + 1] = palette[color + 1];
      data[i + 2] = palette[color + 2];
      data[i + 3] = Math.min(189, alpha * 1.25);
    }
    surface.putImageData(image, 0, 0);
    ctx.drawImage(heat, 0, 0, width, height);
  }

  function draw() {
    canvas.hidden = points.length === 0;
    if (canvas.hidden) {
      bins.clear();
      return;
    }
    const { x: width, y: height } = map.getSize();
    if (!width || !height) return;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const step = map.getZoom() < 6 ? 9 : 6;
    bins = new Map();
    const scale = map.getZoomScale(map.getZoom(), 0);
    const origin = map.getPixelBounds().min;
    const stride = Math.ceil(width / step) + 10;
    for (const point of points) {
      const x = point.x * scale - origin.x;
      const y = point.y * scale - origin.y;
      if (x < -24 || y < -24 || x > width + 24 || y > height + 24) continue;
      const key = Math.floor(y / step) * stride + Math.floor(x / step);
      const bin = bins.get(key);
      if (bin) bin.count += point.weight;
      else bins.set(key, { x, y, lon: point.lon, lat: point.lat, platform: point.platform, count: point.weight });
    }
    if (mode === 'heat') {
      drawHeat(ctx, width, height, ratio);
      return;
    }
    ctx.fillStyle = '#ff382d';
    for (const { x, y, count } of bins.values()) {
      const radius = Math.min(4.4, 1.65 + Math.log2(count) * .43);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  map.on('moveend resize', draw);
  map.on('click', ({ containerPoint, latlng }) => {
    if (!interactive || mode !== 'points') return;
    let selected;
    let nearest = 9;
    for (const bin of bins.values()) {
      const distance = Math.hypot(containerPoint.x - bin.x, containerPoint.y - bin.y);
      if (distance < nearest) {
        nearest = distance;
        selected = bin;
      }
    }
    if (!selected) return;
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = selected.count === 1 ? 'Тепловая точка' : `Детекций рядом — ${number.format(selected.count)}`;
    content.append(title);
    if (selected.count === 1) {
      content.append(document.createElement('br'),
        `${platformNames()[selected.platform] ?? 'NASA FIRMS'} · ${selected.lat.toFixed(4)}°, ${selected.lon.toFixed(4)}°`);
    }
    L.popup().setLatLng(latlng).setContent(content).openOn(map);
  });

  return (data, display, clickable = false) => {
    if (input !== data) points = mercatorPoints(data);
    input = data;
    mode = display;
    interactive = clickable;
    draw();
  };
}
