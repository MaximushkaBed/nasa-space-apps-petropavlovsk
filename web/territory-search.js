import { registerBoundaryNames, translate, uiLanguage } from './i18n.js';
import { circleGeometry } from './analysis-selection.js';
import { normalizeTerritoryName as normalize, searchMunicipalBoundaries } from './municipal-boundaries.js';

const namesFor = ([name, , aliases]) => [name, ...aliases, translate(name)].map(normalize);
const boundarySource = 'Граница города · Overture Maps · © OpenStreetMap contributors';

export function boundaryLoadMessage(error) {
  return error.cityBoundaryUnavailable ? error.message
    : 'Не удалось загрузить границу. Повторите поиск или выделите область на карте.';
}

export function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [aLon, aLat] = ring[i], [bLon, bLat] = ring[j];
    if ((aLat > lat) !== (bLat > lat) && lon < (bLon - aLon) * (lat - aLat) / (bLat - aLat) + aLon) inside = !inside;
  }
  return inside;
}

async function geocodedPlaces(text, getJSON, countryCode) {
  let language = uiLanguage();
  const parts = text.split(',').map(part => part.trim());
  const filter = parts.length === 2 && countryCode;
  const params = new URLSearchParams({ name: filter ? parts[0] : parts.join(', '), count: 6, language });
  if (filter) params.set('countryCode', countryCode);
  const request = () => getJSON(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  let { results = [] } = await request();
  const nameLanguage = /[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/u.test(parts[0]) ? 'kk'
    : /\p{Script=Cyrillic}/u.test(parts[0]) ? 'ru' : 'en';
  if (!results.length && nameLanguage !== language) {
    language = nameLanguage;
    params.set('language', language);
    ({ results = [] } = await request());
  }
  return results.filter(({name, longitude, latitude, country_code, feature_code}) =>
    feature_code?.startsWith('PPL') && name && Number.isFinite(longitude) && Number.isFinite(latitude)
      && latitude > -85 && latitude < 85 && country_code
  ).map(({name, longitude, latitude, admin1, country, country_code}) => ({
    name, label: [...new Set([name, admin1, country, 'Населённый пункт'].filter(Boolean))].join(' · '),
    async load({ radiusKm = 5 } = {}) {
      const query = new URLSearchParams({ name, country: country_code, lon: longitude, lat: latitude, lang: language });
      const { geometry } = await getJSON(`/api/v1/place-boundary?${query}`).catch(() => {
        const error = new Error('Каталог городских границ временно недоступен. Повторите поиск.');
        error.cityBoundaryUnavailable = true;
        throw error;
      });
      if (geometry !== null) {
        return {preset: 'custom', name, source: boundarySource, geometry, bbox: geometryBounds(geometry)};
      }
      const circle = { center: [longitude, latitude], radius_km: radiusKm };
      return {preset: 'custom', name, source: 'GeoNames · Точка + радиус',
        circle, bbox: geometryBounds(circleGeometry(circle))};
    },
  }));
}

function readonlyPreview(geometry) {
  const copy = structuredClone(geometry);
  const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  return freeze(copy);
}

function contains(geometry, [lon, lat]) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(rings => inRing(rings[0], lon, lat) && !rings.slice(1).some(ring => inRing(ring, lon, lat)));
}

// An interior point, rather than a bounding-box centre that may fall outside a
// concave district or in a hole. Exact clipping is still required on selection.
function interiorPoint(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const candidates = [];
  for (const rings of polygons) {
    const box = geometryBounds({type: 'Polygon', coordinates: rings});
    for (const fraction of [.5, .25, .75]) {
      const y = box[1] + (box[3] - box[1]) * fraction, intersections = [];
      for (const ring of rings) for (let i = 1; i < ring.length; i++) {
        const [a, b] = [ring[i - 1], ring[i]];
        if ((a[1] > y) !== (b[1] > y)) intersections.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 1; i < intersections.length; i++) {
        const point = [(intersections[i - 1] + intersections[i]) / 2, y];
        if (contains({type: 'Polygon', coordinates: rings}, point)) candidates.push({point, width: intersections[i] - intersections[i - 1]});
      }
    }
  }
  return candidates.sort((a, b) => b.width - a.width)[0]?.point;
}

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
  let countryCodes;
  const geometryCache = new Map();
  let districtCache;
  async function index() {
    indexPromise ??= getJSON('data/atlas-boundaries/index.json').catch(error => {indexPromise = null;throw error;});
    const catalogue = await indexPromise;
    registerBoundaryNames(catalogue);
    return catalogue;
  }
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
    async children(parentROI, {signal} = {}) {
      const catalogue = await index();
      const reference = parentROI?.boundary_ref;
      let parent = reference && catalogue.find(entry => entry[3] === reference.code && entry[4] === reference.id && entry[5] === reference.level);
      if (!parent && parentROI?.preset === 'sko') parent = catalogue.find(entry => entry[3] === 'KAZ' && entry[5] === 1 && entry[0] === 'Северо-Казахстанская область');
      if (!parent && parentROI?.name) {
        const name = normalize(parentROI.name);
        const exact = catalogue.filter(entry => normalize(entry[0]) === name);
        const aliases = catalogue.filter(entry => [entry[0], ...entry[2].filter(alias => normalize(alias) !== normalize(entry[1]))].map(normalize).includes(name));
        const matches = exact.length ? exact : aliases;
        if (matches.length === 1) parent = matches[0];
        else if (parentROI.bbox) for (const entry of matches) {
          const bbox = geometryBounds((await boundaries(entry[3]))[entry[4]]);
          if (bbox.every((value, i) => Math.abs(value - parentROI.bbox[i]) < .0001)) {parent = entry;break;}
        }
      }
      if (!parent) return {items: [], parent_ref: null, coverage: {status: 'unknown', message: 'Для этой границы нет подтверждённого уровня в каталоге. Можно выделить её часть на карте.'}};
      const [parentName, , , code, id, level] = parent;
      const parent_ref = {code, id, level};
      const nextLevel = level === 0 ? 1 : code === 'KAZ' && level === 1 ? 2 : null;
      if (nextLevel === null) return {items: [], parent_ref, coverage: {status: 'unavailable', message: code === 'USA' && level === 1 ? 'Границы округов и городов этого штата в каталоге отсутствуют. Можно выделить часть области на карте.' : 'Более подробных границ для этой территории в каталоге нет. Можно выделить часть на карте.'}};
      const shapes = await boundaries(code);
      const parentGeometry = parentROI.geometry?.type === 'Feature' ? parentROI.geometry.geometry : parentROI.geometry || (parentROI.preset === 'sko' ? await getSkoGeometry() : shapes[id]);
      const parentBox = geometryBounds(parentGeometry);
      const entries = catalogue.filter(entry => entry[3] === code && entry[5] === nextLevel);
      const items = [];
      for (const [name, country, , , childId, childLevel] of entries) {
        const geometry = shapes[childId], box = geometryBounds(geometry);
        if (box[0] > parentBox[2] || box[2] < parentBox[0] || box[1] > parentBox[3] || box[3] < parentBox[1]) continue;
        // ADM1 has a catalogue country identity; KAZ ADM2 has no explicit ADM1
        // field, so use a true interior point for spatial membership, then
        // intersect the full geometry when the user chooses it.
        const point = interiorPoint(geometry);
        if (nextLevel === 2 && (!point || !contains(parentGeometry, point))) continue;
        const displayName = name === 'Petropavlovsk' ? 'Петропавловск' : name;
        const boundary_ref = {code, id: childId, level: childLevel};
        items.push({id: `${code}:${childId}:${childLevel}`, name: displayName, label: displayName, level: childLevel,
          source: childLevel === 2 ? 'Границы geoBoundaries' : 'Границы Natural Earth',
          previewGeometry: readonlyPreview(geometry), labelPoint: point ? Object.freeze([...point]) : null,
          async load(options = {}) {
            const clipped = await getJSON('/api/v1/geometry/clip', {method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({parent: parentGeometry, geometry}), signal: options.signal || signal});
            return {preset: 'custom', name: displayName, source: childLevel === 2 ? 'Границы geoBoundaries' : 'Границы Natural Earth',
              geometry: clipped.geometry, bbox: clipped.bbox, clipped: clipped.clipped, boundary_ref, parent_ref};
          }});
      }
      items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return {items, parent_ref, coverage: {status: items.length ? 'available' : 'unavailable',
        message: nextLevel === 2 ? 'Районы и города из каталога, чья внутренняя точка находится в выбранной области. При выборе граница точно ограничивается этой областью.'
          : `Регионы страны «${parentName}» из готового каталога. При выборе граница точно ограничивается выбранной территорией.`}};
    },
    async search(text, { includePlaces = true } = {}) {
      const [query, countryQuery] = text.split(',').map(normalize);
      if (!query) return [];
      const cities = searchMunicipalBoundaries(text, getJSON);
      if (cities.length) return cities.map(({name, label, source, loadGeometry}) => ({
        name, label, source,
        async load() {
          const geometry = await loadGeometry();
          return {preset: 'custom', name, source, geometry, bbox: geometryBounds(geometry)};
        },
      }));
      const catalogue = await index();
      const countryEntry = countryQuery && catalogue.find(entry => !entry[5]
        && (namesFor(entry).includes(countryQuery) || normalize(entry[3]) === countryQuery));
      const candidates = countryEntry ? catalogue.filter(entry => entry[3] === countryEntry[3] && entry[5] > 0) : catalogue;
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
            return {preset: isSko ? 'sko' : 'custom', name, source, geometry, bbox: geometryBounds(geometry), boundary_ref: {code, id, level}};
          }};
      });
      const exact = scored[0]?.[0] === 0;
      const exactCountry = exact && scored[0][1][5] === 0;
      if (countryEntry && !countryCodes) countryCodes = getJSON('data/atlas-boundaries/country-codes.json')
        .catch(() => { countryCodes = null; });
      const placeSearch = !exactCountry && (includePlaces || !matches.length)
        ? Promise.resolve(countryEntry ? countryCodes : undefined)
          .then(codes => geocodedPlaces(text, getJSON, codes?.[countryEntry?.[3]]))
          .then(places => ({places}), error => ({error}))
        : {places: []};
      let hasDistricts = false;
      if (countryEntry && countryEntry[3] !== 'KAZ' && !exact && matches.length < 8) {
        try {
          for (const {properties, geometry} of await districts(countryEntry[3])) {
            const name = properties.shapeName;
            if (!name || !geometry || !normalize(name).includes(query)) continue;
            hasDistricts = true;
            matches.push({name, label: `${name} · ${countryEntry[0]}`, source: 'Границы geoBoundaries',
              load: async () => ({preset: 'custom', name, source: 'Границы geoBoundaries', geometry, bbox: geometryBounds(geometry)})});
            if (matches.length === 8) break;
          }
        } catch { /* Indexed borders remain usable if the optional district source fails. */ }
      }
      const { places = [], error } = await placeSearch;
      if (!matches.length && error) throw error;
      return (exact || hasDistricts ? [...matches, ...places] : [...places, ...matches]).slice(0, 8);
    }
  };
}
