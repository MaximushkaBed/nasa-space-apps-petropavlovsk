// The atlas boundary catalogue, ranking and boundary sources are shared with
// area-analysis.js. Loading a result never simplifies or rewrites its geometry.
const normalize = name => String(name || '').toLocaleLowerCase().replace(/ё/g, 'е').normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const namesFor = ([name, , aliases]) => [name, ...aliases].map(normalize);

export function geometryBounds(geometry) {
  if (!['Polygon', 'MultiPolygon'].includes(geometry?.type)) throw new Error('Граница территории недоступна.');
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const points = polygons.flat(2);
  if (!points.length || points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) throw new Error('Неверные координаты границы.');
  return points.reduce(([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)], [180, 90, -180, -90]);
}

export function fitTerritory(map, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const points = polygons.flat(2);
  const plain = L.latLngBounds(points.map(([x, y]) => [y, x]));
  const shifted = L.latLngBounds(points.map(([x, y]) => [y, x < 0 ? x + 360 : x]));
  map.fitBounds(plain.getEast() - plain.getWest() <= shifted.getEast() - shifted.getWest() ? plain : shifted,
    {padding: [35, 35], maxZoom: 11, animate: false});
}

export function createTerritorySearch(getJSON, getSkoGeometry) {
  let indexPromise;
  const geometryCache = new Map();
  let districtCache;
  async function boundaries(code) {
    if (!geometryCache.has(code)) {
      const promise = getJSON(`data/atlas-boundaries/${code}.json`).catch(error => {geometryCache.delete(code);throw error;});
      geometryCache.set(code, promise);
      if (geometryCache.size > 6) geometryCache.delete(geometryCache.keys().next().value);
    }
    return geometryCache.get(code);
  }
  async function districts(code) {
    if (districtCache?.code === code) return districtCache.features;
    const metadata = await getJSON(`https://www.geoboundaries.org/api/current/gbOpen/${code}/ADM2/`);
    const url = new URL(metadata.simplifiedGeometryGeoJSON);
    const download = url.hostname === 'github.com' ? `https://media.githubusercontent.com/media${url.pathname.replace('/raw/', '/')}` : url.href;
    const {features} = await getJSON(download);
    districtCache = {code, features};
    return features;
  }
  return {
    async search(text) {
      const [query, countryQuery] = text.split(',').map(normalize);
      if (!query) return [];
      indexPromise ??= getJSON('data/atlas-boundaries/index.json').catch(error => {indexPromise = null;throw error;});
      const index = await indexPromise;
      const countryEntry = countryQuery && index.find(entry => !entry[5] && namesFor(entry).includes(countryQuery));
      const candidates = countryEntry ? index.filter(entry => entry[3] === countryEntry[3] && entry[5] > 0) : index;
      const words = query.split(' ');
      const scored = candidates.map(entry => {
        const names = namesFor(entry), nameText = [...names, normalize(entry[1])].join(' ');
        return [names.includes(query) ? 0 : names.some(name => name.startsWith(query)) ? 1 : words.every(word => nameText.includes(word)) ? 2 : 3, entry];
      }).filter(([rank]) => rank < 3).sort((a, b) => a[0] - b[0] || a[1][5] - b[1][5]).slice(0, 8);
      const matches = scored.map(([, [name, country, , code, id, level]]) => {
        const isSko = code === 'KAZ' && name === 'Северо-Казахстанская область';
        const source = level === 2 || isSko ? 'Границы geoBoundaries' : 'Границы Natural Earth';
        return {name, label: country ? `${name} · ${country}` : name, source,
          async load() {
            const geometry = isSko ? await getSkoGeometry() : (await boundaries(code))[id];
            return {preset: isSko ? 'sko' : 'custom', name, source, geometry, bbox: geometryBounds(geometry)};
          }};
      });
      if (countryEntry && countryEntry[3] !== 'KAZ' && scored[0]?.[0] !== 0 && matches.length < 8) {
        try {
          for (const {properties, geometry} of await districts(countryEntry[3])) {
            const name = properties.shapeName;
            if (!name || !geometry || !normalize(name).includes(query)) continue;
            matches.push({name, label: `${name} · ${countryEntry[0]}`, source: 'Границы geoBoundaries',
              load: async () => ({preset: 'custom', name, source: 'Границы geoBoundaries', geometry, bbox: geometryBounds(geometry)})});
            if (matches.length === 8) break;
          }
        } catch { /* Indexed borders remain usable if the optional district source fails. */ }
      }
      return matches;
    }
  };
}
