const nominalPixelMeters = [1000, 1000, 375, 375, 375];
const mercatorCircumference = 2 * Math.PI * 6378137;
const mercatorLimit = 85.0511287798;
const overviewSpacing = 24;
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

  const heatPalette = createPalette([[0, '#ff202a'], [.46, '#ff381c'], [.74, '#ff8614'], [.93, '#ffcb38'], [1, '#fff7a0']]);
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

  function drawHeat(ctx, width, height, ratio, bins, radius) {
    const scale = Math.min(ratio, 1, 1400 / Math.max(width, height));
    heat.width = Math.ceil(width * scale);
    heat.height = Math.ceil(height * scale);
    const surface = heat.getContext('2d', { willReadFrequently: true });
    surface.setTransform(scale, 0, 0, scale, 0, 0);
    for (const { x, y, count } of bins.values()) {
      surface.globalAlpha = Math.min(.64, .15 + .052 * Math.log2(count + 1));
      surface.drawImage(dot, x - radius, y - radius, 2 * radius, 2 * radius);
    }
    const image = surface.getImageData(0, 0, heat.width, heat.height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (!alpha) continue;
      const color = alpha * 4;
      data[i] = heatPalette[color];
      data[i + 1] = heatPalette[color + 1];
      data[i + 2] = heatPalette[color + 2];
      data[i + 3] = Math.min(241, 300 * (alpha / 255) ** .66);
    }
    surface.putImageData(image, 0, 0);
    ctx.drawImage(heat, 0, 0, width, height);
  }

  function drawOverview(ctx, bins, width) {
    const spacing = overviewSpacing;
    const stride = Math.ceil(width / spacing) + 4;
    const cells = new Map();
    const groups = [];
    // Keep each marker at its strongest source group and add nearby counts to it.
    const ordered = [...bins.values()].sort((a, b) => b.count - a.count || a.y - b.y || a.x - b.x);
    for (const bin of ordered) {
      const col = Math.floor(bin.x / spacing);
      const row = Math.floor(bin.y / spacing);
      const key = row * stride + col;
      let nearest;
      let distance = spacing * spacing;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const candidates = cells.get(key + dy * stride + dx);
          if (!candidates) continue;
          for (const group of candidates) {
            const squared = (group.x - bin.x) ** 2 + (group.y - bin.y) ** 2;
            if (squared < distance) {
              nearest = group;
              distance = squared;
            }
          }
        }
      }
      if (nearest) nearest.count += bin.count;
      else {
        const group = { ...bin };
        groups.push(group);
        const cell = cells.get(key);
        if (cell) cell.push(group);
        else cells.set(key, [group]);
      }
    }

    groups.sort((a, b) => a.count - b.count);
    const reference = groups[Math.floor((groups.length - 1) * .97)]?.count ?? 1;
    for (const group of groups) {
      const strength = Math.min(1, (group.count / reference) ** .48);
      const half = .85 + 2.65 * strength;
      ctx.globalAlpha = .10 + .84 * strength;
      ctx.beginPath();
      ctx.arc(group.x, group.y, half, 0, 2 * Math.PI);
      ctx.fill();
      hitTargets.push({ ...group, half });
    }
    ctx.globalAlpha = 1;
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
    const heatRadius = overview ? Math.min(34, Math.max(13, worldWidth / 460)) : zoom < 6 ? 17 : 23;
    const margin = detailed ? Math.max(4, maxPixelWidth * scale / 2)
      : mode === 'heat' ? heatRadius : overview ? overviewSpacing + 4 : 8;
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
    if (mode === 'heat') {
      drawHeat(ctx, width, height, ratio, bins, heatRadius);
      return;
    }
    if (detailed) return;
    if (overview) {
      drawOverview(ctx, bins, width);
      return;
    }
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
    const isGroup = aggregated && map.getZoom() < fireDetailZoom;
    const isPixel = !isGroup && selected.count === 1;
    const samePosition = isPixel ? hitTargets.filter(({ x, y }) => x === selected.x && y === selected.y) : [];
    title.textContent = isGroup ? `Детекций в группе — ${number.format(selected.count)}`
      : !isPixel ? `Детекций рядом — ${number.format(selected.count)}`
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
