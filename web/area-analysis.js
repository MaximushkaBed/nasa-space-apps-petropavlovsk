import { numberFormat } from './i18n.js';
import { boundaryLoadMessage, createTerritorySearch, inRing } from './territory-search.js';
export { inRing };
const number = numberFormat({ maximumFractionDigits: 2 });
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

export function createAreaAnalysis(map, onActivate, getJSON, skoGeometry, { scope = document, onChange } = {}) {
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
  const territorySearch = createTerritorySearch(getJSON, () => skoGeometry);
  let searchRevision = 0;
  const modes = [['area-circle', 'circle'], ['area-polygon', 'polygon'], ['area-search-mode', 'search']];
  const region = polygonSelection(skoGeometry);

  function renderSummary() {
    byId('area-clear').hidden = !selection;
    if (!selection) {
      byId('area-name').textContent = 'Весь мир';
      byId('area-meta').textContent = archiveFrame?.date ? `${archiveFrame.date} UTC` : 'Выберите дату наблюдений.';
      byId('area-count').textContent = archiveFrame?.worldTotal !== undefined
        ? `Тепловые детекции · ${number.format(archiveFrame.worldTotal)}`
        : archiveFrame?.local ? 'Показаны данные видимого участка' : 'Загрузка детекций…';
      byId('area-platforms').replaceChildren();
      byId('area-coverage').hidden = true;
      return;
    }
    const counts = new Map();
    let total = 0;
    const detail = archiveFrame?.viewport;
    const withinDetail = detail?.contains && selection.extents.every(detail.contains);
    const partialView = archiveFrame?.local && !withinDetail;
    const points = withinDetail || partialView ? detail?.points : archiveFrame?.points;
    const bounds = partialView ? map.getBounds() : undefined;
    const center = partialView ? map.getCenter().lng : undefined;
    const regionalCounts = !withinDetail && selection.geometry === skoGeometry ? archiveFrame?.regionalByPlatform : undefined;
    if (regionalCounts) {
      for (const [satellite, weight] of Object.entries(regionalCounts)) {
        counts.set(Number(satellite), weight);
        total += weight;
      }
    } else if (points) {
      for (const [lon, lat, satellite, weight = 1] of points) {
        if (!selection.contains(lon, lat)) continue;
        if (bounds && !bounds.contains([lat, wrapNear(lon, center)])) continue;
        counts.set(satellite, (counts.get(satellite) ?? 0) + weight);
        total += weight;
      }
    }
    byId('area-name').textContent = selection.name;
    byId('area-meta').textContent = `${number.format(selection.area)} км² · ${archiveFrame?.date ?? 'выберите дату'} UTC · ${selection.details}`;
    const approximate = !withinDetail && archiveFrame?.approximate && !(regionalCounts && archiveFrame.regionalExact);
    const missing = withinDetail && detail.missing?.length > 0;
    byId('area-count').textContent = points || regionalCounts ? `Тепловые детекции${partialView ? ' в видимой части' : ''} · ${approximate ? '≈ ' : ''}${number.format(total)}`
      : archiveFrame?.failed ? 'Детекции за эту дату недоступны' : 'Данные ещё не загружены';
    const coverage = byId('area-coverage');
    coverage.hidden = !(points || regionalCounts) || (!approximate && !partialView && !missing && total > 0);
    const cell = archiveFrame?.cellDegrees;
    coverage.textContent = partialView ? 'Отдалите карту, чтобы увидеть счётчик для всей области.'
      : approximate ? `Оценка по ячейкам${cell ? ` ${number.format(cell)}°` : ''}. Приблизьте карту так, чтобы вся зона попала в кадр.`
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
      || (method === 'polygon' && vertices.length) || (method === 'report' && selection?.circle));
    instruction.hidden = !panel.hidden || !drawing();
    instruction.textContent = method === 'circle' ? 'Выберите центр на карте, задайте радиус, затем нажмите «Анализ территории».' : 'Поставьте первую вершину на карте.';
    byId('area-radius-label').hidden = byId('area-presets').hidden = !selection?.circle || method === 'search' || method === 'polygon';
    byId('area-polygon-controls').hidden = method !== 'polygon';
    byId('area-search').hidden = method !== 'search';
    byId('area-sources').hidden = method !== 'search';
    byId('area-title').textContent = method === 'search' ? 'Поиск территории'
      : method === 'polygon' ? 'Новый полигон' : 'Круговая область для анализа';
    guide.textContent = method === 'polygon' ? 'Добавьте хотя бы три вершины и замкните полигон.'
      : method === 'search' ? 'Для района укажите название и страну через запятую.'
      : method === 'circle' || (method === 'report' && selection?.circle) ? 'Выберите центр и задайте радиус области, затем нажмите «Анализ территории».' : '';
    guide.hidden = !guide.textContent;
    renderSummary();
  }

  function setMethod(next) {
    searchRevision++;
    method = next;
    for (const [id, value] of modes) byId(id).setAttribute('aria-pressed', String(method === value));
    if (method !== 'search') results.replaceChildren();
    renderTools();
  }

  function selectCircle(center, place = null) {
    if (!radius.validity.valid || !radius.valueAsNumber) return;
    const km = radius.valueAsNumber;
    const distance = Math.sin(km / (2 * earthRadius)) ** 2;
    const latitude = center.lat * radians;
    const angularRadius = km / earthRadius;
    const dx = Math.abs(latitude) + angularRadius >= Math.PI / 2 ? 180
      : Math.asin(Math.sin(angularRadius) / Math.cos(latitude)) / radians;
    const dy = angularRadius / radians;
    selection = {
      name: place?.name || `Радиус ${number.format(km)} км`, area: 4 * Math.PI * earthRadius ** 2 * distance,
      details: place?.source || `${center.lat.toFixed(4)}°, ${L.Util.wrapNum(center.lng, [-180,180]).toFixed(4)}°`,
      place,
      circle: true, center, radius: km,
      extents: [{ west: center.lng - dx, east: center.lng + dx, south: center.lat - dy, north: center.lat + dy }],
      contains: (lon, lat) => Math.sin((lat * radians - latitude) / 2) ** 2
        + Math.cos(latitude) * Math.cos(lat * radians) * Math.sin((lon - center.lng) * radians / 2) ** 2 <= distance,
    };
    redraw();
    renderTools();
    onChange?.(getSelection());
  }

  function selectPolygon(geometry, name, details, boundaryRef) {
    selection = { ...polygonSelection(geometry), name, details, geometry, boundaryRef };
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
    if (value === 'polygon') { vertices = []; redraw(); }
    setMethod(value);
    if (value === 'search') byId('area-query').focus();
  });
  byId('area-close').addEventListener('click', () => {
    const tool = modes.find(([, value]) => method === value)?.[0] ?? 'area-circle';
    resetDraft();
    if (!byId(tool).hidden) byId(tool).focus();
  });
  for (const [id] of modes) byId(id).disabled = false;
  const changeRadius = () => { if (selection?.circle) selectCircle(selection.center, selection.place); };
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
  function clearSelection() {
    selection = undefined;
    vertices = [];
    redraw();
    setMethod('');
    onChange?.(null);
  }
  byId('area-clear').addEventListener('click', clearSelection);

  function showSearchResult(match, revision) {
    const button = document.createElement('button');
    button.className = 'quiet-button';
    button.type = 'button';
    button.textContent = match.label;
    button.addEventListener('click', async () => {
      if (revision !== searchRevision) return;
      results.textContent = 'Загрузка границы…';
      try {
        const roi = await match.load({ radiusKm: radius.validity.valid && radius.valueAsNumber || 5 });
        if (revision !== searchRevision) return;
        if (roi.circle) {
          radius.value = roi.circle.radius_km;
          const [lon, lat] = roi.circle.center;
          const center = L.latLng(lat, lon);
          setMethod('report');
          selectCircle(center, roi);
          map.setView(center, 11, { animate: false });
        } else {
          selectPolygon(roi.geometry, roi.name, roi.source, roi.boundary_ref);
          fitBoundary(roi.geometry);
        }
      } catch (error) {
        if (revision === searchRevision) results.textContent = boundaryLoadMessage(error);
      }
    });
    return button;
  }

  byId('area-search').addEventListener('submit', async event => {
    event.preventDefault();
    const text = byId('area-query').value.trim();
    if (!text) return;
    const revision = ++searchRevision;
    results.textContent = 'Поиск границ…';
    try {
      const matches = await territorySearch.search(text);
      if (revision !== searchRevision) return;
      results.replaceChildren(...matches.map(match => showSearchResult(match, revision)));
      if (!matches.length) results.textContent = 'Место не найдено. Уточните название или выделите полигон.';
    } catch {
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
    if (selection.circle) {
      const longitude = selection.center.lng;
      // Keep already canonical input exact: modulo-wrapping 179.8 introduces a
      // rounding change and invalidates a scientifically identical saved study.
      const canonical = longitude >= -180 && longitude <= 180 ? longitude : L.Util.wrapNum(longitude, [-180,180]);
      roi.circle = { center: [canonical, selection.center.lat], radius_km: selection.radius };
    }
    else {
      roi.geometry = selection.geometry;
      if (selection.boundaryRef) roi.boundary_ref = selection.boundaryRef;
    }
    return roi;
  }
  function setSelection(roi) {
    if (!roi) return;
    if (roi.circle) {
      radius.value = roi.circle.radius_km;
      const [lon, lat] = roi.circle.center;
      selectCircle(L.latLng(lat, lon), roi.source?.startsWith('GeoNames ·') ? roi : null);
      setMethod('report');
    }
    else if (roi.preset === 'sko') selectPolygon(skoGeometry, roi.name || 'Северо-Казахстанская область', roi.source || 'Граница СКО', roi.boundary_ref);
    else if (roi.geometry) selectPolygon(roi.geometry, roi.name || 'Выбранная территория', roi.source || 'Переданная граница', roi.boundary_ref);
    else if (roi.bbox) { const [w,s,e,n] = roi.bbox; selectPolygon({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] }, roi.name || 'Прямоугольник', roi.source || 'Граница окна'); }
  }
  function intersectsRegion() {
    return !selection || selection.extents.some(a => region.extents.some(b => {
      const shift = 360 * Math.round((b.west + b.east - a.west - a.east) / 720);
      return a.west + shift <= b.east && a.east + shift >= b.west && a.south <= b.north && a.north >= b.south;
    }));
  }
  return { render(frame) { archiveFrame = frame; renderSummary(); }, resetDraft, drawing, getSelection, setSelection, clearSelection,
    contains: ({ lat, lng }) => !selection || selection.contains(lng, lat),
    intersectsRegion, active: () => Boolean(method) };
}
