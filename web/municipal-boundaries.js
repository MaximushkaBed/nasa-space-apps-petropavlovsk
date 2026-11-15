const municipalities = [{
  name: 'Лос-Анджелес',
  aliases: ['Los Angeles', 'Лосс Анджелес', 'Лос Анделес', 'Лосс Анделес'],
  region: 'Калифорния',
  country: 'США',
  qualifiers: ['California', 'CA', 'United States', 'United States of America', 'US', 'USA', 'АҚШ', 'Америка Құрама Штаттары'],
  source: 'City of Los Angeles · Bureau of Engineering',
  path: 'data/atlas-boundaries/los-angeles.geojson',
}];

export const normalizeTerritoryName = name => String(name || '').toLocaleLowerCase().replace(/ё/g, 'е').normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function searchMunicipalBoundaries(text, getJSON) {
  const [query, ...qualifiers] = text.split(',').map(normalizeTerritoryName);
  return municipalities.filter(city => {
    const names = [city.name, ...city.aliases].map(normalizeTerritoryName);
    const areas = [city.region, city.country, ...city.qualifiers].map(normalizeTerritoryName);
    return names.includes(query) && qualifiers.every(area => !area || areas.includes(area));
  }).map(({name, region, country, source, path}) => ({
    name, label: `${name} · ${region} · ${country} · Граница города`, source,
    async loadGeometry() { return (await getJSON(path)).geometry; },
  }));
}
