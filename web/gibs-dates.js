const capabilitiesUrl = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml';
const dayMs = 86400000;
const isoDay = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);
const monthNumber = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

function previousDate(interval, target) {
  const [start, end = start, step = 'P1D'] = interval.split('/');
  const origin = Date.parse(start);
  const last = Math.min(target, Date.parse(end));
  if (!Number.isFinite(origin) || !Number.isFinite(last) || last < origin) return -Infinity;
  const count = Number(step.slice(1, -1));
  if (step.endsWith('D') && count > 0) return origin + Math.floor((last - origin) / (count * dayMs)) * count * dayMs;
  if (step.endsWith('M') && count > 0) {
    const first = new Date(origin);
    const months = Math.floor((monthNumber(new Date(last)) - monthNumber(first)) / count) * count;
    const periodDate = (offset) => Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + offset, first.getUTCDate());
    const candidate = periodDate(months);
    if (candidate <= last) return candidate;
    if (months > 0) return periodDate(months - count);
  }
  return -Infinity;
}

export function createGibsDates() {
  let cached;

  function catalog() {
    cached ??= fetch(capabilitiesUrl, { signal: AbortSignal.timeout(6500) }).then(async (response) => {
      if (!response.ok) throw new Error(`NASA GIBS · HTTP ${response.status}`);
      const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
      const entries = new Map();
      for (const layer of xml.getElementsByTagNameNS('*', 'Layer')) {
        const name = [...layer.children].find((child) => child.localName === 'Identifier')?.textContent;
        const dimension = [...layer.children].find((child) => child.localName === 'Dimension'
          && child.getElementsByTagNameNS('*', 'Identifier')[0]?.textContent.toLowerCase() === 'time');
        if (name && dimension) entries.set(name, [...dimension.getElementsByTagNameNS('*', 'Value')].map((node) => node.textContent.trim()));
      }
      if (!entries.size) throw new Error('NASA GIBS · empty date catalog');
      return entries;
    }).catch(() => { cached = undefined; return null; });
    return cached;
  }

  return async (layer, targetDay, maxLagDays) => {
    const dates = (await catalog())?.get(layer);
    if (!dates?.length) return { day: targetDay, verified: false };
    const target = Date.parse(targetDay);
    const previous = dates.reduce((latest, interval) => Math.max(latest, previousDate(interval, target)), -Infinity);
    if (!Number.isFinite(previous) || target - previous > maxLagDays * dayMs) return { verified: true };
    return { day: isoDay(previous), verified: true };
  };
}
