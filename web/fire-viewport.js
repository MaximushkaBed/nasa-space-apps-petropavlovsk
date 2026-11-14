const zoomDelay = 220;
const cacheLimit = 12;
const cacheLifetime = 60_000;
const wrap = (longitude) => ((longitude + 180) % 360 + 360) % 360 - 180;

function boundsFor(map) {
  const bounds = map.getBounds();
  return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
}

function contains(outer, inner) {
  const shift = 360 * Math.round((outer.west + outer.east - inner.west - inner.east) / 720);
  return outer.west <= inner.west + shift && inner.east + shift <= outer.east
    && outer.south <= inner.south && inner.north <= outer.north;
}

function requestBounds(view, { maxWidth, maxHeight }) {
  const { west, south, east, north } = view;
  const width = east - west, height = north - south;
  if (width > maxWidth - .0002 || height > maxHeight - .0002) return;
  const dx = Math.min(width * .15, (maxWidth - width - .0002) / 2);
  const dy = Math.min(height * .15, (maxHeight - height - .0002) / 2);
  return {
    west: Math.floor((west - dx) * 10000) / 10000,
    east: Math.ceil((east + dx) * 10000) / 10000,
    south: Math.max(-90, Math.floor((south - dy) * 10000) / 10000),
    north: Math.min(90, Math.ceil((north + dy) * 10000) / 10000),
  };
}

export function createFireViewport(map, minZoom, onFrame) {
  let query;
  let request;
  let prefetch;
  let timer;
  const cache = new Map();
  let attempt;
  let pending;

  function publish(frame) {
    if (frame?.status !== 'loading') {
      pending?.resolve();
      pending = undefined;
    }
    onFrame(frame);
  }

  function abort() {
    clearTimeout(timer);
    timer = undefined;
    if (request) attempt = undefined;
    request?.abort();
    request = undefined;
  }

  function cancelPrefetch() {
    prefetch?.controller.abort();
    prefetch = undefined;
  }

  function cachedFrame(key, view) {
    const entry = cache.get(key);
    return entry?.expiresAt > Date.now() && contains(entry.bounds, view) ? entry : undefined;
  }

  function remember(key, bounds, frame) {
    cache.delete(key);
    cache.set(key, { bounds, frame, expiresAt: Date.now() + cacheLifetime });
    if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }

  function bboxFor(bounds) {
    return [wrap(bounds.west), bounds.south, wrap(bounds.east), bounds.north].map((n) => n.toFixed(4)).join(',');
  }

  async function fetchFrame({ start, end, satellite }, bounds, signal) {
    const params = new URLSearchParams({ start, end, bbox: bboxFor(bounds) });
    if (satellite !== '') params.set('satellite', satellite);
    const response = await fetch(`/api/fires/viewport?${params}`, { signal });
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    const frame = response.status === 404 ? { status: 'unavailable' } : await response.json();
    if (frame.status === 'ok') {
      if (!Array.isArray(frame.points)) throw new Error('Invalid detail frame');
      frame.contains = (area) => contains(bounds, area);
      frame.coversView = () => frame.contains(boundsFor(map));
      frame.countVisible = () => {
        const currentView = boundsFor(map);
        return frame.points.reduce((total, [lon, lat]) =>
          total + Number(contains(currentView, { west: lon, east: lon, south: lat, north: lat })), 0);
      };
    }
    return frame;
  }

  function refresh(allowBusyRetry = true, immediate = false) {
    clearTimeout(timer);
    if (!query || map.getZoom() < minZoom) {
      abort();
      cancelPrefetch();
      publish(undefined);
      return;
    }
    const view = boundsFor(map);
    if (prefetch && !contains(prefetch.bounds, view)) cancelPrefetch();
    const cached = cachedFrame(query.key, view);
    if (cached) {
      abort();
      cache.delete(query.key);
      cache.set(query.key, cached);
      publish(cached.frame);
      return;
    }
    const upcoming = prefetch?.key === query.key ? prefetch : undefined;
    const bounds = upcoming?.bounds ?? requestBounds(view, query);
    if (!bounds) {
      abort();
      publish({ status: 'too_wide' });
      return;
    }
    const bbox = bboxFor(bounds);
    if ((request && attempt && contains(attempt.bounds, view))
      || (attempt?.bbox === bbox && attempt.frame.status !== 'ok')) {
      publish(attempt.frame);
      return;
    }
    abort();
    if (!upcoming) cancelPrefetch();
    publish({ status: 'loading' });
    const load = async () => {
      const controller = upcoming?.controller ?? new AbortController();
      if (prefetch === upcoming) prefetch = undefined;
      request = controller;
      attempt = { bbox, bounds, frame: { status: 'loading' } };
      try {
        const frame = await (upcoming?.promise ?? fetchFrame(query, bounds, controller.signal));
        if (controller.signal.aborted) return;
        if (frame.reason === 'busy' && allowBusyRetry) {
          attempt = undefined;
          timer = setTimeout(() => refresh(false), 700);
          return;
        }
        attempt.frame = frame;
        if (frame.status === 'ok') remember(query.key, bounds, frame);
        request = undefined;
        publish(frame);
      } catch {
        if (controller.signal.aborted) return;
        attempt.frame = { status: 'error' };
        request = undefined;
        publish(attempt.frame);
      } finally {
        if (request === controller) request = undefined;
      }
    };
    if (upcoming || immediate) load();
    else timer = setTimeout(load, zoomDelay);
  }

  map.on('moveend resize', () => refresh());
  return {
    fits(limits) {
      return map.getZoom() >= minZoom && Boolean(requestBounds(boundsFor(map), limits));
    },
    select(next, immediate = false) {
      if (query?.key === next?.key) return pending?.promise;
      abort();
      if (prefetch?.key !== next?.key) cancelPrefetch();
      pending?.resolve();
      pending = undefined;
      query = next;
      attempt = undefined;
      if (query) {
        pending = {};
        pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
      }
      const promise = pending?.promise;
      refresh(true, immediate);
      return promise;
    },
    prefetch(next) {
      if (request || pending || map.getZoom() < minZoom) return;
      const view = boundsFor(map);
      if (cachedFrame(next.key, view) || (prefetch?.key === next.key && contains(prefetch.bounds, view))) return;
      const bounds = requestBounds(view, next);
      if (!bounds) return;
      cancelPrefetch();
      const controller = new AbortController();
      const entry = { key: next.key, bounds, controller };
      prefetch = entry;
      entry.promise = fetchFrame(next, bounds, controller.signal).then(frame => {
        if (!controller.signal.aborted && frame.status === 'ok') remember(next.key, bounds, frame);
        return frame;
      }).catch(() => ({ status: 'error' })).finally(() => {
        if (prefetch === entry) prefetch = undefined;
      });
    },
    cancelPrefetch,
    retry() {
      attempt = undefined;
      refresh();
    },
  };
}
