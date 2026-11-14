const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 });
const normalize = (name) => name.toLocaleLowerCase().replace(/ё/g, 'е').normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const earthRadius = 6371.0088;
const radians = Math.PI / 180;
const wrapNear = (lon, center) => lon + 360 * Math.round((center - lon) / 360);

function outline(polygons) {
  return polygons.map((rings) => {
    const ring = rings[0];
    const [west, south, east, north] = ring.reduce(([w,s,e,n], [x,y]) =>
      [Math.min(w,x), Math.min(s,y), Math.max(e,x), Math.max(n,y)], [Infinity, Infinity, -Infinity, -Infinity]);
    return { rings, center: (west + east) / 2, west, south, east, north };
  });
}

export function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [aLon, aLat] = ring[i], [bLon, bLat] = ring[j];
    if ((aLat > lat) !== (bLat > lat) && lon < (bLon - aLon) * (lat - aLat) / (bLat - aLat) + aLon) inside = !inside;
  }
  return inside;
}

function sphericalArea(ring) {
  return Math.abs(ring.reduce((total, [lon, lat], i) => {
    const [nextLon, nextLat] = ring[(i + 1) % ring.length];
    return total + (nextLon - lon) * radians * (Math.sin(lat * radians) + Math.sin(nextLat * radians));
  }, 0)) * earthRadius ** 2 / 2;
}

function polygonSelection(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const prepared = outline(polygons);
  const area = polygons.reduce((total, rings) => total + sphericalArea(rings[0])
    - rings.slice(1).reduce((sum, ring) => sum + sphericalArea(ring), 0), 0);
  return {
    area,
    extents: prepared,
    contains(lon, lat) {
      return prepared.some(({ rings, center, south, north, west, east }) => {
        if (lat < south || lat > north) return false;
        const x = wrapNear(lon, center);
        return x >= west && x <= east && inRing(rings[0], x, lat) && !rings.slice(1).some((ring) => inRing(ring, x, lat));
      });
    },
  };
}

export function createAreaAnalysis(map, onActivate, getJSON, skoGeometry, { scope = document, onChange, onMode } = {}) {
  const byId = (id) => scope.querySelector('#' + id);
  const layer = L.layerGroup().addTo(map);
  map.createPane('analysis-area').style.zIndex = 407;
  const style = { pane: 'analysis-area', color: '#61e4f6', weight: 2, fillOpacity: .10, interactive: false };
  const radius = byId('area-radius');
  const guide = byId('area-guide');
  const results = byId('area-results');
  const panel = byId('area-panel');
  const instruction = byId('area-instruction');
  let method = '';
  let vertices = [];
  let selection;
  let archiveFrame;
  let boundaryIndex;
  let lastDistrictSearch;
  let searchRevision = 0;
  const modes = [['area-circle', 'circle'], ['area-polygon', 'polygon'], ['area-search-mode', 'search']];

  function renderSummary() {
    byId('area-summary').hidden = !selection;
    byId('area-report').hidden = !selection || !panel.hidden;
    if (!selection) return;
    const counts = new Map();
    let total = 0;
    const detail = archiveFrame?.viewport;
    const withinDetail = detail?.contains && selection.extents.every(detail.contains);
    const points = withinDetail ? detail.points : archiveFrame?.points;
    const regionalCounts = !withinDetail && selection.geometry === skoGeometry ? archiveFrame?.regionalByPlatform : undefined;
    if (regionalCounts) {
      for (const [satellite, weight] of Object.entries(regionalCounts)) {
        counts.set(Number(satellite), weight);
        total += weight;
      }
    } else if (points) {
      for (const [lon, lat, satellite, weight = 1] of points) {
        if (!selection.contains(lon, lat)) continue;
        counts.set(satellite, (counts.get(satellite) ?? 0) + weight);
        total += weight;
      }
    }
    byId('area-name').textContent = selection.name;
    byId('area-meta').textContent = `${number.format(selection.area)} км² · ${archiveFrame?.date ?? 'выберите дату'} UTC · ${selection.details}`;
    const approximate = !withinDetail && archiveFrame?.approximate && !(regionalCounts && archiveFrame.regionalExact);
    const missing = withinDetail && detail.missing?.length > 0;
    byId('area-count').textContent = points ? `Тепловые детекции · ${approximate ? '≈ ' : ''}${number.format(total)}`
      : archiveFrame?.local ? 'Часть области за пределами загруженного кадра'
      : archiveFrame?.failed ? 'Детекции за эту дату недоступны' : 'Данные ещё не загружены';
    const coverage = byId('area-coverage');
    coverage.hidden = !points || (!approximate && !missing && total > 0);
    const cell = archiveFrame?.cellDegrees;
    coverage.textContent = approximate ? `Оценка по ячейкам${cell ? ` ${number.format(cell)}°` : ''}. Приблизьте карту так, чтобы вся зона попала в кадр.`
      : missing ? 'Часть дат в архиве недоступна.' : 'В архиве нет точек внутри границы. Покрытие спутниками неизвестно.';
    byId('area-platforms').replaceChildren(...[...counts].sort((a,b) => b[1] - a[1]).map(([id, count]) => {
      const item = document.createElement('li');
      const label = archiveFrame.platforms[id] ?? (regionalCounts && !archiveFrame.regionalExact ? 'Все спутники' : 'Другие спутники');
      item.textContent = `${label} · ${number.format(count)}`;
      return item;
    }));
  }

  function redraw() {
    layer.clearLayers();
    if (selection?.circle) {
      const center = [selection.center.lat, wrapNear(selection.center.lng, map.getCenter().lng)];
      L.circle(center, { ...style, radius: selection.radius * 1000 }).addTo(layer);
      L.circleMarker(center, { ...style, radius: 4, fillOpacity: 1 }).addTo(layer);
    } else if (selection) {
      const center = map.getCenter().lng;
      const polygons = selection.geometry.type === 'Polygon' ? [selection.geometry.coordinates] : selection.geometry.coordinates;
      for (const rings of polygons) {
        const first = rings[0][0][0];
        const shift = wrapNear(first, center) - first;
        L.polygon(rings.map((ring) => ring.map(([lon, lat]) => [lat, lon + shift])), style).addTo(layer);
      }
    } else if (vertices.length) {
      L.polyline(vertices, { ...style, dashArray: '4 5' }).addTo(layer);
      for (const point of vertices) L.circleMarker(point, { ...style, radius: 3, fillOpacity: 1 }).addTo(layer);
    }
    byId('area-finish').disabled = vertices.length < 3;
    byId('area-undo').disabled = !vertices.length;
  }

  function drawing() {
    return method === 'circle' || method === 'polygon';
  }

  function renderTools() {
    map.getContainer().classList.toggle('selecting-area', drawing());
    panel.hidden = !(method === 'search' || (method === 'circle' && selection?.circle)
      || (method === 'polygon' && vertices.length) || method === 'report');
    instruction.hidden = !panel.hidden || !drawing();
    instruction.textContent = method === 'circle' ? 'Поставьте точку на карте.' : 'Поставьте первую вершину на карте.';
    byId('area-radius-label').hidden = byId('area-presets').hidden = !selection?.circle || method === 'search' || method === 'polygon';
    byId('area-polygon-controls').hidden = method !== 'polygon';
    byId('area-search').hidden = method !== 'search';
    byId('area-sources').hidden = method !== 'search';
    byId('area-title').textContent = method === 'search' ? 'Поиск территории'
      : method === 'polygon' ? 'Новый полигон' : 'Выделенная территория';
    guide.textContent = method === 'polygon' ? 'Добавьте хотя бы три вершины и замкните полигон.'
      : method === 'search' ? 'Для района укажите название и страну через запятую.'
      : method === 'circle' ? 'Щёлкните по карте, чтобы переместить центр.' : '';
    guide.hidden = !guide.textContent;
    renderSummary();
  }

  function setMethod(next) {
    searchRevision++;
    method = next;
    for (const [id, value] of modes) byId(id).setAttribute('aria-pressed', String(method === value));
    if (method !== 'search') results.replaceChildren();
    renderTools();
    onMode?.(method);
  }

  function selectCircle(center) {
    if (!radius.validity.valid || !radius.valueAsNumber) return;
    const km = radius.valueAsNumber;
    const distance = Math.sin(km / (2 * earthRadius)) ** 2;
    const latitude = center.lat * radians;
    const angularRadius = km / earthRadius;
    const dx = Math.abs(latitude) + angularRadius >= Math.PI / 2 ? 180
      : Math.asin(Math.sin(angularRadius) / Math.cos(latitude)) / radians;
    const dy = angularRadius / radians;
    selection = {
      name: `Радиус ${number.format(km)} км`, area: 4 * Math.PI * earthRadius ** 2 * distance,
      details: `${center.lat.toFixed(4)}°, ${L.Util.wrapNum(center.lng, [-180,180]).toFixed(4)}°`,
      circle: true, center, radius: km,
      extents: [{ west: center.lng - dx, east: center.lng + dx, south: center.lat - dy, north: center.lat + dy }],
      contains: (lon, lat) => Math.sin((lat * radians - latitude) / 2) ** 2
        + Math.cos(latitude) * Math.cos(lat * radians) * Math.sin((lon - center.lng) * radians / 2) ** 2 <= distance,
    };
    redraw();
    renderTools();
    onChange?.(getSelection());
  }

  function selectPolygon(geometry, name, details) {
    selection = { ...polygonSelection(geometry), name, details, geometry };
    vertices = [];
    redraw();
    setMethod('report');
    onChange?.(getSelection());
  }

  function fitBoundary(geometry) {
    // Fit a single longitude interval across the date line if the region crosses it.
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const all = polygons.flat(2);
    const plain = L.latLngBounds(all.map(([x,y]) => [y,x]));
    const shifted = L.latLngBounds(all.map(([x,y]) => [y,x < 0 ? x+360 : x]));
    const bounds = plain.getEast() - plain.getWest() <= shifted.getEast() - shifted.getWest() ? plain : shifted;
    const { x: width, y: height } = map.getSize();
    const phone = width <= 420;
    map.fitBounds(bounds, {
      paddingTopLeft: [26, 108], paddingBottomRight: phone ? [26, Math.round(height * .46)] : [Math.min(width * .45, 375), 105],
      maxZoom: 13, animate: false,
    });
    redraw();
  }

  for (const [id, value] of modes) byId(id).addEventListener('click', () => {
    const active = method === value;
    onActivate();
    if (active) return;
    if (value === 'polygon') { selection = undefined; vertices = []; redraw(); }
    setMethod(value);
    if (value === 'search') byId('area-query').focus();
  });
  byId('area-report').addEventListener('click', () => { onActivate(); setMethod('report'); });
  byId('area-close').addEventListener('click', () => {
    const tool = modes.find(([, value]) => method === value)?.[0] ?? 'area-report';
    resetDraft();
    if (!byId(tool).hidden) byId(tool).focus();
  });
  for (const [id] of modes) byId(id).disabled = false;
  const changeRadius = () => { if (selection?.circle) selectCircle(selection.center); };
  radius.addEventListener('input', changeRadius);
  for (const button of scope.querySelectorAll('[data-radius]')) button.addEventListener('click', () => {
    radius.value = button.dataset.radius;
    changeRadius();
  });
  map.on('click', ({ latlng }) => {
    if (method === 'circle') {
      if (!radius.validity.valid || !radius.valueAsNumber) return;
      selectCircle(latlng);
      setMethod('report');
    } else if (method === 'polygon') {
      const previous = vertices.at(-1);
      vertices.push([latlng.lat, previous ? wrapNear(latlng.lng, previous[1]) : latlng.lng]);
      redraw();
      renderTools();
    }
  });
  map.on('moveend', () => { if (selection) redraw(); });
  byId('area-finish').addEventListener('click', () => {
    const ring = vertices.map(([lat, lon]) => [lon, lat]);
    ring.push(ring[0]);
    if (sphericalArea(ring) < .001) {
      guide.textContent = 'Выберите минимум три вершины, которые образуют область.';
      return;
    }
    selectPolygon({ type: 'Polygon', coordinates: [ring] }, 'Пользовательский полигон', `${vertices.length} вершин`);
  });
  byId('area-undo').addEventListener('click', () => { vertices.pop(); redraw(); renderTools(); });
  byId('area-clear').addEventListener('click', () => {
    selection = undefined;
    vertices = [];
    redraw();
    setMethod('');
    onChange?.(null);
  });

  function namesFor([name, , aliases]) {
    return [name, ...aliases].map(normalize);
  }

  async function loadDistricts(code) {
    if (lastDistrictSearch?.code === code) return lastDistrictSearch.features;
    const metadata = await getJSON(`https://www.geoboundaries.org/api/current/gbOpen/${code}/ADM2/`);
    const url = new URL(metadata.simplifiedGeometryGeoJSON);
    const download = url.hostname === 'github.com'
      ? `https://media.githubusercontent.com/media${url.pathname.replace('/raw/', '/')}` : url.href;
    const { features } = await getJSON(download);
    lastDistrictSearch = { code, features };
    return features;
  }

  function showBoundaryResult(name, label, revision, loadGeometry, source) {
    const button = document.createElement('button');
    button.className = 'quiet-button';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (revision !== searchRevision) return;
      results.textContent = 'Загрузка границы…';
      try {
        const geometry = await loadGeometry();
        if (revision !== searchRevision) return;
        selectPolygon(geometry, name, source);
        fitBoundary(geometry);
        results.replaceChildren();
      } catch {
        if (revision === searchRevision) results.textContent = 'Не удалось загрузить границы.';
      }
    });
    return button;
  }

  byId('area-search').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = byId('area-query').value.trim();
    const [query, countryQuery] = text.split(',').map(normalize);
    if (!query) return;
    const revision = ++searchRevision;
    results.textContent = 'Поиск границ…';
    try {
      boundaryIndex ??= getJSON('data/atlas-boundaries/index.json');
      const index = await boundaryIndex;
      if (revision !== searchRevision) return;
      const countryEntry = countryQuery && index.find((entry) => !entry[5] && namesFor(entry).includes(countryQuery));
      const candidates = countryEntry ? index.filter((entry) => entry[3] === countryEntry[3] && entry[5] > 0) : index;
      const words = query.split(' ');
      const scored = candidates.map((entry) => {
        const names = namesFor(entry);
        const nameText = [...names, normalize(entry[1])].join(' ');
        if (names.includes(query)) return [0, entry];
        if (names.some((value) => value.startsWith(query))) return [1, entry];
        return [words.every((word) => nameText.includes(word)) ? 2 : 3, entry];
      }).filter(([rank]) => rank < 3).sort((a, b) => a[0] - b[0] || a[1][5] - b[1][5]).slice(0, 8);
      const matches = scored.map(([, [name, country, , code, id, level]]) => {
        const isSKO = code === 'KAZ' && name === 'Северо-Казахстанская область';
        return showBoundaryResult(name, country ? `${name} · ${country}` : name, revision,
          async () => isSKO ? skoGeometry : (await getJSON(`data/atlas-boundaries/${code}.json`))[id],
          level === 2 || isSKO ? 'Границы geoBoundaries' : 'Границы Natural Earth');
      });
      if (countryEntry && countryEntry[3] !== 'KAZ' && scored[0]?.[0] !== 0 && matches.length < 8) {
        try {
          const districts = await loadDistricts(countryEntry[3]);
          for (const { properties, geometry } of districts) {
            const name = properties.shapeName;
            if (!name || !geometry || !normalize(name).includes(query)) continue;
            matches.push(showBoundaryResult(name, `${name} · ${countryEntry[0]}`, revision, () => geometry, 'Границы geoBoundaries'));
            if (matches.length === 8) break;
          }
        } catch {
          if (revision === searchRevision && !matches.length) results.textContent = 'Границы районов этой страны недоступны. Можно нарисовать полигон.';
          if (!matches.length) return;
        }
      }
      if (revision !== searchRevision) return;
      results.replaceChildren(...matches);
      if (!matches.length) {
        const params = new URLSearchParams({ name: countryEntry ? text.split(',')[0].trim() : text, count: 6, language: 'ru' });
        const places = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
        if (revision !== searchRevision) return;
        results.replaceChildren(...(places.results ?? []).filter((place) => !countryEntry || namesFor(countryEntry).includes(normalize(place.country ?? ''))).map((place) => {
          const button = document.createElement('button');
          button.className = 'quiet-button';
          button.type = 'button';
          button.textContent = [place.name, place.admin1, place.country, 'точка + радиус'].filter(Boolean).join(' · ');
          button.addEventListener('click', () => {
            setMethod('report');
            const center = L.latLng(place.latitude, place.longitude);
            selectCircle(center);
            map.setView(center, 11, { animate: false });
          });
          return button;
        }));
        if (!results.children.length) results.textContent = 'Место не найдено. Уточните название или выделите полигон.';
      }
    } catch {
      boundaryIndex = undefined;
      if (revision === searchRevision) results.textContent = 'Не удалось загрузить поиск.';
    }
  });

  function resetDraft() {
    if (vertices.length) { vertices = []; redraw(); }
    setMethod('');
  }

  function getSelection() {
    if (!selection) return null;
    const extents = selection.extents;
    const bbox = [Math.min(...extents.map(e => e.west)), Math.min(...extents.map(e => e.south)), Math.max(...extents.map(e => e.east)), Math.max(...extents.map(e => e.north))];
    const roi = { preset: selection.geometry === skoGeometry ? 'sko' : 'custom', name: selection.name, bbox, source: selection.details };
    if (selection.circle) roi.circle = { center: [L.Util.wrapNum(selection.center.lng, [-180,180]), selection.center.lat], radius_km: selection.radius };
    else roi.geometry = selection.geometry;
    return roi;
  }
  function setSelection(roi) {
    if (!roi) return;
    if (roi.circle) { radius.value = roi.circle.radius_km; selectCircle(L.latLng(roi.circle.center[1], roi.circle.center[0])); setMethod('report'); }
    else if (roi.preset === 'sko') selectPolygon(skoGeometry, roi.name || 'Северо-Казахстанская область', roi.source || 'Граница СКО');
    else if (roi.geometry) selectPolygon(roi.geometry, roi.name || 'Выбранная территория', roi.source || 'Переданная граница');
    else if (roi.bbox) { const [w,s,e,n] = roi.bbox; selectPolygon({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] }, roi.name || 'Прямоугольник', roi.source || 'Граница окна'); }
  }
  return { render(frame) { archiveFrame = frame; renderSummary(); }, resetDraft, drawing, getSelection, setSelection,
    active: () => Boolean(method) };
}
