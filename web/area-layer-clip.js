const svgNS = 'http://www.w3.org/2000/svg';
const clipPanes = ['temperature-background', 'observation-rasters', 'terrain-shading', 'weather-field', 'activity-cells', 'event-layers', 'wind-flow', 'world-wind'];
const radians = Math.PI / 180;
const wrapNear = (lon, center) => lon + 360 * Math.round((center - lon) / 360);

function ringsFor({ circle, geometry }) {
  if (!circle) return (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
  const [lon, lat] = circle.center;
  const origin = lat * radians;
  const angle = circle.radius_km / 6371.0088;
  const ring = Array.from({ length: 128 }, (_, i) => {
    const bearing = i * 2 * Math.PI / 128;
    const y = Math.asin(Math.sin(origin) * Math.cos(angle) + Math.cos(origin) * Math.sin(angle) * Math.cos(bearing));
    const x = Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(origin), Math.cos(angle) - Math.sin(origin) * Math.sin(y));
    return [lon + x / radians, y / radians];
  });
  return [[ring]];
}

export function createAreaLayerClip(map, {panes = clipPanes, id = 'atlas-selection-clip'} = {}) {
  const sprite = document.createElementNS(svgNS, 'svg');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('width', '0');
  sprite.setAttribute('height', '0');
  sprite.style.position = 'absolute';
  const clip = document.createElementNS(svgNS, 'clipPath');
  clip.id = id;
  clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('clip-rule', 'evenodd');
  clip.append(path);
  sprite.append(clip);
  map.getContainer().append(sprite);
  let polygons;

  function update() {
    for (const name of panes) {
      const pane = map.getPane(name);
      if (pane) pane.style.clipPath = polygons ? `url(#${id})` : '';
    }
    if (!polygons) return;
    const center = map.getCenter().lng;
    const bounds = map.getBounds();
    const paths = [];
    for (const polygon of polygons) {
      const reference = polygon[0][0][0];
      const shift = wrapNear(reference, center) - reference;
      for (let copy = -1; copy <= 1; copy++) {
        const offset = shift + 360 * copy;
        if (reference + offset < bounds.getWest() - 180 || reference + offset > bounds.getEast() + 180) continue;
        for (const ring of polygon) {
          const points = ring.map(([lon, lat]) => map.latLngToLayerPoint([lat, lon + offset]));
          paths.push(`M${points.map(p => `${p.x},${p.y}`).join('L')}Z`);
        }
      }
    }
    path.setAttribute('d', paths.join(' '));
  }

  map.on('moveend zoomend resize', update);
  return {
    select(roi) { polygons = roi && ringsFor(roi); update(); },
    update,
  };
}
