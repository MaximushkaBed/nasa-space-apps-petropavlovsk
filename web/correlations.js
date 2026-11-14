const byId = (id) => document.getElementById(id);
const sensor = byId('factor-sensor');
const buttons = [...document.querySelectorAll('.factor-view button')];
const table = byId('factor-matrix');
const count = new Intl.NumberFormat('ru');
const coefficient = new Intl.NumberFormat('ru', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});
const timeFactors = [
  ['Тепловые точки', 'Сигналы', 'Больше ячеек с тепловым сигналом за день'],
  ['Температура', 'Температура', 'Выше максимальная температура воздуха'],
  ['Скорость ветра', 'Ветер', 'Выше средняя скорость ветра'],
  ['Осадки за день', 'Осадки', 'Больше осадков в день наблюдения'],
  ['Осадки за предыдущие 7 дней', 'Осадки 7 дн.', 'Больше осадков за предыдущие семь дней'],
  ['Влажность воздуха', 'Влажн. воздуха', 'Выше относительная влажность воздуха'],
  ['Влажность почвы 0–7 см', 'Влажн. почвы', 'Выше влажность верхнего слоя почвы'],
  ['Расход Ишима', 'Расход Ишима', 'Выше модельный расход воды в Ишиме у Петропавловска'],
];
const spaceFactors = [
  ['Плотность тепловых точек', 'Сигналы/км²', 'Больше ячейко-дней с сигналом на км²'],
  ['Расстояние до поселений', 'До поселений', 'Дальше ближайший населённый пункт'],
  ['Медианная высота', 'Высота', 'Выше местность'],
  ['Перепад высот', 'Перепад высот', 'Больше перепад высот'],
  ['Доля леса', 'Лес', 'Выше доля леса'],
  ['Доля травяного покрова', 'Трава', 'Выше доля травяного покрова'],
  ['Доля пашни', 'Пашня', 'Выше доля пашни'],
  ['Доля заболоченной растительности', 'Болота', 'Выше доля заболоченной растительности'],
];

let data;
let mode = 'within';
let selection;
let activeCell;

function label(value) {
  return coefficient.format(Math.round(value * 100) / 100).replace('-', '−');
}

function selectPair(row, col, button) {
  const spatial = mode === 'space';
  const factors = spatial ? spaceFactors : timeFactors;
  selection = [row, col];
  if (col < row) [row, col] = [col, row];
  const [value, n] = data.results[sensor.value][mode][row][col];
  const other = sensor.value === 'aqua' ? 'noaa20' : 'aqua';
  const [check, checkN] = data.results[other][mode][row][col];
  activeCell?.setAttribute('aria-pressed', 'false');
  activeCell = button;
  activeCell.setAttribute('aria-pressed', 'true');
  byId('factor-pair').textContent = `${factors[row][0]} и ${factors[col][0].toLocaleLowerCase('ru')}`;
  byId('factor-value').textContent = value === null
    ? 'Нет оценки'
    : `ρ ${label(value)} · ${count.format(n)} ${spatial ? 'уч.' : 'дн.'}`;

  let reading = 'В доступных наблюдениях мало пар с различающимися значениями.';
  if (value !== null) {
    const strength = Math.abs(value);
    if (strength < .1) {
      reading = 'Заметной связи в этих наблюдениях не видно.';
    } else {
      const left = row === 0 ? factors[col][2] : factors[row][2];
      const right = row === 0
        ? `${value > 0 ? 'больше' : 'меньше'} тепловых сигналов ${spatial ? 'на км²' : 'за день'}`
        : `${value > 0 ? 'выше' : 'ниже'} значения показателя «${factors[col][0]}»`;
      reading = `${left} — обычно ${right}. ${strength < .3 ? 'Связь слабая.' : strength < .6 ? 'Связь умеренная.' : 'Связь сильная.'}`;
    }
  }
  byId('factor-reading').textContent = reading;
  const otherName = other === 'aqua' ? 'Aqua / MODIS' : 'NOAA‑20 / VIIRS';
  byId('factor-check').textContent = check === null
    ? `${otherName} · нет оценки`
    : `${otherName} · ρ ${label(check)} · ${count.format(checkN)} ${spatial ? 'уч.' : 'дн.'}`;
}

function render() {
  const spatial = mode === 'space';
  const factors = spatial ? spaceFactors : timeFactors;
  const values = data.results[sensor.value][mode];
  if (!selection) {
    const candidates = values[0].slice(1).map(([v], i) => [v === null ? -1 : Math.abs(v), i + 1]);
    candidates.sort((a, b) => b[0] - a[0]);
    selection = [0, candidates[0][1]];
  }
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.value === mode));
  const base = spatial
    ? `${count.format(data.areas)} участков · сравнение плотности наблюдений за шесть сезонов.`
    : `До ${count.format(data.days)} суток · ${mode === 'within'
      ? 'дни сравниваются внутри отдельных месяцев каждого года.'
      : 'все даты сравниваются вместе, включая сезонные различия.'}`;
  byId('factor-scope').textContent = base;
  table.replaceChildren();
  const headers = table.createTHead().insertRow();
  headers.append(document.createElement('th'));
  for (const [full, short] of factors) {
    const header = document.createElement('th');
    header.scope = 'col';
    header.textContent = short;
    header.title = full;
    headers.append(header);
  }
  const body = table.createTBody();
  for (const [i, [full]] of factors.entries()) {
    const row = body.insertRow();
    const header = document.createElement('th');
    header.scope = 'row';
    header.textContent = full;
    row.append(header);
    for (const [j, [value, n]] of values[i].entries()) {
      const td = row.insertCell();
      if (i === j) {
        td.className = 'factor-self';
        td.textContent = '—';
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = value === null ? 'н/д' : label(value);
      button.title = `${full} и ${factors[j][0]}. ${value === null ? 'Нет оценки' : `ρ ${label(value)} · ${n}`}`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', 'false');
      if (value !== null) {
        button.style.setProperty('--factor-color', value < 0 ? '#5c95e6' : '#e88b4e');
        button.style.setProperty('--factor-strength', `${Math.round(Math.abs(value) * 92)}%`);
        if (value < -.77 || value > .68) button.classList.add('factor-dark-text');
      }
      button.addEventListener('click', () => selectPair(i, j, button));
      td.append(button);
      if (selection[0] === i && selection[1] === j) selectPair(i, j, button);
    }
  }
}

try {
  const response = await fetch('data/correlations.json?v=sko-factors');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  data = await response.json();
  for (const button of buttons) {
    button.disabled = false;
    button.addEventListener('click', () => {
      if (button.value === mode) return;
      mode = button.value;
      selection = null;
      render();
    });
  }
  sensor.disabled = false;
  sensor.addEventListener('change', render);
  render();
  byId('factor-layout').hidden = false;
} catch (error) {
  byId('factor-scope').textContent = 'Не удалось загрузить матрицу. Обновите страницу.';
  console.error(error);
}
