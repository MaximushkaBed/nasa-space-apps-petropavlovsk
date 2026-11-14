const nominalPixelMeters = [1000, 1000, 375, 375, 375];
const mercatorCircumference = 2 * Math.PI * 6378137;
const mercatorLimit = 85.0511287798;
const pixelZoom = 9;
const projectedPixelWidth = (meters, latitude) => 256 * meters
  / (mercatorCircumference * Math.cos(latitude * Math.PI / 180));
const maxPixelWidth = projectedPixelWidth(1000, mercatorLimit);

export function createFireOverlay(map, platformNames, number, withinRegion, allowPopup) {
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
    const latitude = Math.max(-mercatorLimit, Math.min(mercatorLimit, lat));
    const pixelWidth = projectedPixelWidth(nominalPixelMeters[platform] ?? 0, latitude);
    return { lon, lat, platform, weight, x: point.x, y: point.y, pixelWidth, regional: withinRegion(lon, lat) };
  });
  let points = [];
  let regionalCount = 0;
  let mode = 'points';
  let visible = true;
  let aggregated = false;
  let bins = new Map();
  let hitTargets = [];
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
    canvas.hidden = !visible || points.length === 0;
    hitTargets = [];
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
    const worldWidth = 256 * scale;
    const detailed = mode === 'points' && !aggregated && map.getZoom() >= pixelZoom;
    const margin = detailed ? Math.max(4, maxPixelWidth * scale / 2) : 24;
    const firstCopy = Math.floor((origin.x - margin) / worldWidth);
    const lastCopy = Math.floor((origin.x + width + margin) / worldWidth);
    const stride = Math.ceil(width / step) + 10;
    ctx.fillStyle = '#ff382d';
    for (const point of points) {
      const y = point.y * scale - origin.y;
      if (y < -margin || y > height + margin) continue;
      const baseX = point.x * scale - origin.x;
      for (let copy = firstCopy; copy <= lastCopy; copy++) {
        const x = baseX + copy * worldWidth;
        if (x < -margin || x > width + margin) continue;
        if (detailed) {
          const size = Math.max(3, point.pixelWidth * scale);
          const half = size / 2;
          ctx.fillRect(x - half, y - half, size, size);
          hitTargets.push({ x, y, half, lon: point.lon, lat: point.lat, platform: point.platform, count: 1 });
          continue;
        }
        const index = Math.floor(y / step) * stride + Math.floor(x / step);
        const key = index * 2 + Number(point.regional);
        const bin = bins.get(key);
        if (bin) bin.count += point.weight;
        else bins.set(key, { x, y, lon: point.lon, lat: point.lat, platform: point.platform, regional: point.regional, count: point.weight });
      }
    }
    if (mode === 'heat') {
      drawHeat(ctx, width, height, ratio);
      return;
    }
    if (detailed) return;
    for (const regional of [false, true]) {
      for (const bin of bins.values()) {
        if (bin.regional !== regional) continue;
        const { x, y, count } = bin;
        const half = Math.min(3.8, (regional ? 2.1 : 1.4) + Math.log2(count) * .37);
        ctx.fillRect(x - half, y - half, half * 2, half * 2);
        hitTargets.push({ ...bin, half });
      }
    }
  }

  map.on('moveend resize', draw);
  map.on('click', ({ containerPoint, latlng }) => {
    if (!allowPopup() || mode !== 'points') return;
    let selected;
    let nearest = Infinity;
    for (const target of hitTargets) {
      const dx = Math.abs(containerPoint.x - target.x), dy = Math.abs(containerPoint.y - target.y);
      if (Math.max(dx, dy) > Math.max(target.half, 6)) continue;
      const distance = Math.hypot(dx, dy);
      if (distance >= nearest) continue;
      nearest = distance;
      selected = target;
    }
    if (!selected) return;
    const content = document.createElement('div');
    const title = document.createElement('strong');
    const single = !aggregated && selected.count === 1;
    title.textContent = single ? 'Тепловая детекция' : `Детекций в группе — ${number.format(selected.count)}`;
    content.append(title);
    if (single) {
      content.append(document.createElement('br'),
        `${platformNames()[selected.platform] ?? 'NASA FIRMS'} · ${selected.lat.toFixed(4)}°, ${selected.lon.toFixed(4)}°`);
      const meters = nominalPixelMeters[selected.platform];
      if (meters) content.append(document.createElement('br'), `Номинальный пиксель · ${meters === 1000 ? '1 км' : '375 м'}`);
    }
    L.popup().setLatLng(latlng).setContent(content).openOn(map);
  });

  return (data, display, show, grouped) => {
    if (input !== data) {
      points = mercatorPoints(data);
      regionalCount = points.reduce((total, point) => total + (point.regional ? point.weight : 0), 0);
    }
    input = data;
    mode = display;
    visible = show;
    aggregated = grouped;
    draw();
    return regionalCount;
  };
}
