const isNumber = Number.isFinite;

export function numericValue(value) {
  if (isNumber(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^−/, '-')
    .replace(/(?<=\d)[ \u00a0\u202f](?=\d{3}(?:\D|$))/g, '');
  if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const parsed = Number(normalized.replace(',', '.'));
  return isNumber(parsed) ? parsed : null;
}

export function dateKey(value) {
  if (value instanceof Date && isNumber(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  const str = value.trim();
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?)?$/i.exec(str);
  if (iso) {
    const [, year, month, day, clock, offset] = iso;
    const key = validDate(year, month, day);
    if (!key || !clock) return key;
    const time = new Date(`${key}T${clock}${offset || 'Z'}`);
    return isNumber(time.valueOf()) ? time.toISOString().slice(0, 10) : null;
  }
  const localDay = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(str);
  if (localDay) return validDate(localDay[3], localDay[2].padStart(2, '0'), localDay[1].padStart(2, '0'));
  const localMonth = /^(\d{1,2})\.(\d{4})$/.exec(str);
  return localMonth ? validDate(localMonth[2], localMonth[1].padStart(2, '0')) : null;
}

function validDate(year, month, day) {
  const key = `${year}-${month}${day ? '-' + day : ''}`;
  const date = new Date(key);
  return isNumber(date.valueOf()) && date.toISOString().startsWith(key) ? key : null;
}

function ranks(values) {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranked = new Float64Array(values.length);
  for (let first = 0; first < order.length;) {
    let end = first + 1;
    while (end < order.length && values[order[end]] === values[order[first]]) end++;
    for (let i = first; i < end; i++) ranked[order[i]] = (first + end - 1) / 2;
    first = end;
  }
  return ranked;
}

function pairedRanks(rows, i, j, minimum) {
  const x = [], y = [];
  for (const row of rows) {
    if (isNumber(row[i]) && isNumber(row[j])) {
      x.push(row[i]);
      y.push(row[j]);
    }
  }
  const detail = { n_overlap: x.length, n_used: 0, reason: 'insufficient_pairs' };
  if (x.length < minimum) return { cell: [null, x.length], detail };
  const a = ranks(x), b = ranks(y), mean = (x.length - 1) / 2;
  let covariance = 0, varianceA = 0, varianceB = 0;
  for (let k = 0; k < a.length; k++) {
    const u = a[k] - mean, v = b[k] - mean;
    covariance += u * v;
    varianceA += u * u;
    varianceB += v * v;
  }
  if (!varianceA || !varianceB) {
    detail.reason = 'constant';
    return { cell: [null, x.length], detail };
  }
  detail.reason = 'ok';
  detail.n_used = x.length;
  const rho = Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceA * varianceB)));
  return { cell: [Math.round(rho * 1e6) / 1e6, x.length], detail };
}

function rowGroups(rows, labels) {
  const groups = new Map();
  rows.forEach((row, i) => {
    const key = labels[i];
    if (!key || !row.some(isNumber)) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

function aggregate(rows, column, method, expected) {
  let sum = 0, count = 0;
  for (const row of rows) {
    if (isNumber(row[column])) {
      sum += row[column];
      count++;
    }
  }
  if (!count || (expected && count !== expected)) return null;
  const result = method === 'sum' ? sum : sum / count;
  return isNumber(result) ? result : null;
}

function atlasRows({ result, platform }, monthly) {
  const { dates, conditions, fire } = result.time_series;
  const rows = dates.map((_, i) => [fire[platform][i], ...conditions[i]]);
  if (!monthly) return new Map(dates.map((key, i) => [key, rows[i]]));
  const groups = rowGroups(rows, dates.map(day => day.slice(0, 7)));
  return new Map([...groups].map(([key, group]) => {
    const [year, month] = key.split('-').map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const row = result.time_factors.map((factor, i) => {
      const method = ['fire', 'rain'].includes(factor.id) ? 'sum' : 'mean';
      return aggregate(group, i, method, days);
    });
    return [key, row];
  }));
}

export function fileMatrix({ rows, names, columns, timeColumn, grain, method, atlas, fileName, sheet }) {
  const importedFactors = columns.map(index => ({ id: `file_${index + 1}`, label: names[index] }));
  const values = rows.map(row => columns.map(index => numericValue(row[index])));
  const monthly = grain === 'month';
  const axis = atlas ? monthly ? 'Месяцы' : 'Дни' : 'Строки файла';
  const minimum = atlas && !monthly ? 30 : 3;
  const factors = atlas ? [...atlas.result.time_factors, ...importedFactors] : importedFactors;
  let series = values, labels = rows.map((_, i) => `Наблюдение ${i + 1}`), invalidDates = 0, validPeriods = 0, mergedRows = 0;
  if (atlas) {
    const keys = rows.map(row => {
      const key = dateKey(row[timeColumn]);
      return monthly ? key?.slice(0, 7) : key?.length === 10 ? key : null;
    });
    invalidDates = keys.filter(key => !key).length;
    const grouped = rowGroups(values, keys);
    validPeriods = grouped.size;
    mergedRows = [...grouped.values()].reduce((sum, items) => sum + items.length - 1, 0);
    const atlasByDate = atlasRows(atlas, monthly);
    labels = [...grouped.keys()].sort().filter(key => atlasByDate.get(key)?.some(isNumber));
    series = labels.map(key => [
      ...atlasByDate.get(key),
      ...columns.map((_, i) => aggregate(grouped.get(key), i, method)),
    ]);
  }
  const cells = factors.map(() => []);
  const details = factors.map(() => []);
  for (let i = 0; i < factors.length; i++) {
    for (let j = i; j < factors.length; j++) {
      const { cell, detail } = pairedRanks(series, i, j, minimum);
      cells[i][j] = cells[j][i] = cell;
      details[i][j] = details[j][i] = detail;
    }
  }
  const platform = atlas?.platform ?? 'Файл';
  const skippedValues = values.reduce((sum, row) => sum + row.filter(value => value === null).length, 0);
  const warnings = [
    `Для оценки нужно не менее ${minimum} общих наблюдений с изменяющимися значениями. Пропуски исключаются отдельно для каждой пары.`,
    'Корреляция описывает связь. Общий тренд и сезонность могут влиять на результат.',
  ];
  if (atlas && monthly) warnings.push('Для каждого фактора атласа используются полные месяцы. Активность и суточные осадки суммируются, остальные факторы усредняются.');
  if (atlas) warnings.push('Файл относится к выбранной территории. Проверьте, что география таблицы совпадает с областью атласа.');
  return {
    version: 'file-spearman-v1',
    analysis_id: atlas?.result.analysis_id,
    config: atlas?.result.config,
    snapshot_at: atlas?.result.snapshot_at,
    through: atlas?.result.through,
    platforms: [platform],
    time_factors: factors,
    results: { [platform]: { pooled: cells } },
    pair_details: { [platform]: { pooled: details } },
    imported: { fileName, sheet, axis, minimum, labels, series, invalidDates, validPeriods, mergedRows, skippedValues,
      fieldCount: columns.length, inputRows: rows.length, timeColumn: atlas ? names[timeColumn] : undefined,
      aggregation: atlas ? method : undefined, initialPair: [0, atlas ? factors.length - columns.length : 1] },
    warnings,
  };
}
