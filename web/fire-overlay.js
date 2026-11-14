const nominalPixelMeters = [1000, 1000, 375, 375, 375];
const mercatorCircumference = 2 * Math.PI * 6378137;
const mercatorLimit = 85.0511287798;
export const fireDetailZoom = 7;
const projectedPixelWidth = (meters, latitude) => 256 * meters
  / (mercatorCircumference * Math.cos(latitude * Math.PI / 180));
const maxPixelWidth = projectedPixelWidth(1000, mercatorLimit);

function createPalette(stops) {
  const ramp = document.createElement('canvas');
  ramp.width = 256;
  ramp.height = 1;
  const colors = ramp.getContext('2d');
  const gradient = colors.createLinearGradient(0, 0, 256, 0);
  for (const [stop, color] of stops) gradient.addColorStop(stop, color);
  colors.fillStyle = gradient;
  colors.fillRect(0, 0, 256, 1);
  return colors.getImageData(0, 0, 256, 1).data;
}

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

  const heatPalette = createPalette([[0, '#ff962d'], [.45, '#f44918'], [.78, '#ffbc36'], [1, '#fff288']]);
  const overviewPalette = createPalette([[0, '#de8d32'], [.45, '#e7a242'], [1, '#ffe7a1']]);
  const mercatorPoints = (data) => data.map(([lon, lat, platform, weight = 1, acquiredAt]) => {
    const point = map.project([lat, lon], 0);
    const latitude = Math.max(-mercatorLimit, Math.min(mercatorLimit, lat));
    const pixelWidth = projectedPixelWidth(nominalPixelMeters[platform] ?? 0, latitude);
    return { lon, lat, platform, weight, acquiredAt, x: point.x, y: point.y, pixelWidth, regional: withinRegion(lon, lat) };
  });
  let points = [];
  let detail;
  let regionalCount = 0;
  let mode = 'points';
  let visible = true;
  let aggregated = false;
  let hitTargets = [];
  let input;
  let detailInput;

  function overviewRadius(worldWidth, lat) {
    return Math.min(230, Math.max(18, worldWidth / 360 / Math.max(.32, Math.cos(lat * Math.PI / 180))));
  }

  function drawHeat(ctx, width, height, ratio, bins, worldWidth, overview) {
    const scale = Math.min(ratio, 1, 1400 / Math.max(width, height));
    heat.width = Math.ceil(width * scale);
    heat.height = Math.ceil(height * scale);
    const surface = heat.getContext('2d', { willReadFrequently: true });
    surface.setTransform(scale, 0, 0, scale, 0, 0);
    const heatRadius = map.getZoom() < 6 ? 17 : 23;
    for (const { x, y, count, lat } of bins.values()) {
      const radius = overview ? overviewRadius(worldWidth, lat) : heatRadius;
      surface.globalAlpha = overview ? Math.min(.4, .025 + .032 * Math.log2(count + 1))
        : Math.min(.65, .025 + .045 * Math.log2(count + 1));
      surface.drawImage(dot, x - radius, y - radius, 2 * radius, 2 * radius);
    }
    const image = surface.getImageData(0, 0, heat.width, heat.height);
    const data = image.data;
    const palette = overview ? overviewPalette : heatPalette;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (!alpha) continue;
      const color = alpha * 4;
      data[i] = palette[color];
      data[i + 1] = palette[color + 1];
      data[i + 2] = palette[color + 2];
      data[i + 3] = overview ? Math.min(182, alpha) : Math.min(189, alpha * 1.25);
    }
    surface.putImageData(image, 0, 0);
    ctx.drawImage(heat, 0, 0, width, height);
  }

  function draw() {
    const zoom = map.getZoom();
    const detailZoom = zoom >= fireDetailZoom;
    const frame = aggregated && detailZoom ? detail : points;
    canvas.hidden = !visible || !frame?.length;
    hitTargets = [];
    if (canvas.hidden) return;
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
    const step = zoom < 6 ? 9 : 6;
    const bins = new Map();
    const scale = map.getZoomScale(zoom, 0);
    const origin = map.getPixelBounds().min;
    const worldWidth = 256 * scale;
    const overview = aggregated && !detailZoom;
    const detailed = mode === 'points' && detailZoom;
    const margin = detailed ? Math.max(4, maxPixelWidth * scale / 2) : overview ? overviewRadius(worldWidth, mercatorLimit) : 24;
    const firstCopy = Math.floor((origin.x - margin) / worldWidth);
    const lastCopy = Math.floor((origin.x + width + margin) / worldWidth);
    const stride = Math.ceil((width + 2 * margin) / step) + 1;
    ctx.fillStyle = '#ff382d';
    for (const point of frame) {
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
          hitTargets.push({ ...point, x, y, half, count: 1 });
          continue;
        }
        const index = Math.floor(y / step) * stride + Math.floor(x / step);
        const key = index * 2 + Number(point.regional);
        const bin = bins.get(key);
        if (bin) {
          bin.count += point.weight;
          bin.x += (x - bin.x) * point.weight / bin.count;
          bin.y += (y - bin.y) * point.weight / bin.count;
        } else bins.set(key, { ...point, x, y, count: point.weight });
      }
    }
    if (mode === 'heat' || overview) {
      drawHeat(ctx, width, height, ratio, bins, worldWidth, overview);
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

  function appendObservation(content, observation) {
    const meters = nominalPixelMeters[observation.platform];
    const sensor = platformNames()[observation.platform] ?? 'NASA FIRMS';
    content.append(document.createElement('br'), sensor);
    if (meters) content.append(document.createElement('br'), `Номинальный пиксель · ${meters === 1000 ? '1 км' : '375 м'}`);
    if (observation.acquiredAt) {
      const timestamp = observation.acquiredAt.replace('T', ' ').replace(/Z$/, '');
      content.append(document.createElement('br'), `${timestamp} UTC`);
    }
  }

  map.on('moveend resize', draw);
  map.on('click', ({ containerPoint, latlng }) => {
    if (!allowPopup() || mode !== 'points') return;
    let selected;
    let nearest = Infinity;
    let insidePixel = false;
    for (const target of hitTargets) {
      const dx = Math.abs(containerPoint.x - target.x), dy = Math.abs(containerPoint.y - target.y);
      const edge = Math.max(dx, dy);
      if (edge > Math.max(target.half, 6)) continue;
      const inside = edge <= target.half;
      const distance = Math.hypot(dx, dy);
      if ((insidePixel && !inside) || (inside === insidePixel && distance >= nearest)) continue;
      nearest = distance;
      insidePixel = inside;
      selected = target;
    }
    if (!selected) return;
    const content = document.createElement('div');
    const title = document.createElement('strong');
    const isPixel = selected.count === 1;
    const samePosition = isPixel ? hitTargets.filter(({ x, y }) => x === selected.x && y === selected.y) : [];
    title.textContent = !isPixel ? `Детекций рядом — ${number.format(selected.count)}`
      : samePosition.length > 1 ? `Детекций в этой точке — ${number.format(samePosition.length)}` : 'Тепловая детекция';
    content.append(title);
    if (isPixel) {
      content.append(document.createElement('br'), `${selected.lat.toFixed(4)}°, ${selected.lon.toFixed(4)}°`);
      for (const observation of samePosition.slice(0, 6)) appendObservation(content, observation);
      if (samePosition.length > 6) content.append(document.createElement('br'), `Ещё ${number.format(samePosition.length - 6)} детекций`);
    } else {
      content.append(document.createElement('br'), 'Приблизьте карту для отдельных детекций.');
    }
    L.popup().setLatLng(latlng).setContent(content).openOn(map);
  });

  return (data, display, show, grouped, detailPoints) => {
    if (input !== data) {
      points = mercatorPoints(data);
      regionalCount = points.reduce((total, point) => total + (point.regional ? point.weight : 0), 0);
    }
    if (detailInput !== detailPoints) detail = detailPoints && mercatorPoints(detailPoints);
    input = data;
    detailInput = detailPoints;
    mode = display;
    visible = show;
    aggregated = grouped;
    draw();
    return regionalCount;
  };
}
