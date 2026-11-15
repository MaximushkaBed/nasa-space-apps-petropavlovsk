import { dateKey, fileMatrix, numericValue } from './matrix-file-data.js';
import { mountMatrixPanel } from './matrix-panel.js?v=file-matrix';

const maxFileBytes = 10 * 1024 * 1024;
const maxFactors = 12;
const number = new Intl.NumberFormat('ru');

export function mountFileMatrix(root) {
  root.className = 'matrix-import';
  root.innerHTML = `<details>
    <summary>Свои данные <span>CSV, Excel</span></summary>
    <p>В первой строке укажите названия столбцов. Файл читается на устройстве.</p>
    <form class="matrix-import-form">
      <div class="matrix-import-fields">
        <label>Файл<input type="file" class="matrix-file" accept=".csv,.xlsx,.xls"></label>
        <label class="matrix-sheet-field" hidden>Лист Excel<select class="matrix-sheet"></select></label>
      </div>
      <div class="matrix-import-settings" hidden>
        <div class="matrix-import-fields">
          <label>Данные для матрицы<select class="matrix-file-mode">
            <option value="atlas">Файл + атлас</option>
            <option value="file">Только по файлу</option>
          </select></label>
        </div>
        <div class="matrix-import-join" hidden>
          <p class="matrix-import-atlas"></p>
          <div class="matrix-import-fields">
            <label>Столбец с датой<select class="matrix-date-column"></select></label>
            <label>Сопоставлять по<select class="matrix-file-grain"><option value="day">Дням UTC</option><option value="month">Месяцам UTC</option></select></label>
            <label>Если в файле несколько строк за период<select class="matrix-file-aggregate"><option value="mean">Среднее</option><option value="sum">Сумма</option></select></label>
          </div>
          <p>Используйте данные для территории атласа. Даты можно указать как 2025-04-12, 12.04.2025 или 2025-04 для месячных данных.</p>
        </div>
        <fieldset class="matrix-file-columns"><legend>Числовые показатели</legend><div></div></fieldset>
        <p class="matrix-file-requirements"></p>
        <button type="submit" class="quiet-button matrix-file-calculate">Рассчитать по файлу</button>
      </div>
    </form>
    <p class="matrix-file-status" role="status" hidden></p>
    <div class="matrix-file-result" hidden></div>
  </details>`;
  const $ = (selector) => root.querySelector(selector);
  const fileInput = $('.matrix-file');
  const sheet = $('.matrix-sheet');
  const form = $('.matrix-import-form');
  const settings = $('.matrix-import-settings');
  const mode = $('.matrix-file-mode');
  const date = $('.matrix-date-column');
  const grain = $('.matrix-file-grain');
  const aggregate = $('.matrix-file-aggregate');
  const columns = $('.matrix-file-columns div');
  const button = $('.matrix-file-calculate');
  const status = $('.matrix-file-status');
  const resultRoot = $('.matrix-file-result');
  let matrix, worker, file, names, rows, activeSheet, atlas, atlasSelection, output, revision = 0;
  let selected = new Set();

  function message(text = '', error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-error', error);
  }

  function clearResult() {
    if (!output) return;
    output = undefined;
    resultRoot.hidden = true;
    matrix.reset();
  }

  function refresh() {
    const joined = mode.value === 'atlas';
    $('.matrix-import-join').hidden = !joined;
    const config = atlasSelection?.result?.config;
    if (joined) {
      const territory = config?.roi_name || (config?.preset === 'world' ? 'Весь мир' : 'Выбранная территория');
      $('.matrix-import-atlas').textContent = config
        ? `${territory} · ${config.start} — ${config.end} · ${atlasSelection.platform}${atlas ? '' : ' · Нет наблюдений этого спутника. Выберите другой спутник в матрице атласа.'}`
        : 'Ожидаем расчёт факторов атласа для выбранной территории и периода.';
    }
    for (const input of columns.querySelectorAll('input')) {
      input.disabled = joined && input.value === date.value;
      input.checked = !input.disabled && selected.has(Number(input.value));
    }
    const count = [...selected].filter(index => !joined || String(index) !== date.value).length;
    const enough = count >= (joined ? 1 : 2);
    const requirements = $('.matrix-file-requirements');
    requirements.textContent = count > maxFactors ? `Выберите не более ${maxFactors} показателей.`
      : !enough ? joined ? 'Выберите хотя бы один показатель.' : 'Выберите хотя бы два показателя.'
      : joined && date.value === '' ? 'Выберите столбец с датой.' : '';
    requirements.hidden = !requirements.textContent;
    button.disabled = !rows || !enough || count > maxFactors || (joined && (!atlas || date.value === ''));
    button.textContent = joined ? 'Рассчитать с атласом' : 'Рассчитать по файлу';
  }

  function labelColumns() {
    const checked = rows.map(row => row.map(numericValue));
    const fields = names.map((name, index) => {
      const example = checked.find(row => Number.isFinite(row[index]))?.[index];
      return { name, index, example };
    }).filter(field => Number.isFinite(field.example));
    selected = new Set(fields.slice(0, 4).map(field => field.index));
    columns.replaceChildren(...fields.map(({ name, index, example }) => {
      const label = document.createElement('label');
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', value: String(index) });
      label.append(input, document.createTextNode(name));
      label.title = `${name} · пример ${number.format(example)}`;
      return label;
    }));
    columns.closest('fieldset').hidden = fields.length === 0;
    date.replaceChildren(new Option('Выберите столбец', ''), ...names.map((name, index) => new Option(name, index)));
    const suggested = names.findIndex((_, i) => rows.slice(0, 30).some(row => dateKey(row[i])));
    date.value = suggested < 0 ? '' : String(suggested);
    guessGrain();
    return fields.length;
  }

  function guessGrain() {
    if (date.value === '') return;
    const dates = rows.slice(0, 30).flatMap(row => dateKey(row[Number(date.value)]) || []);
    grain.value = dates.length && dates.every(day => day.length === 7) ? 'month' : 'day';
  }

  function load(messageData) {
    const request = ++revision;
    clearResult();
    rows = undefined;
    settings.hidden = true;
    message('Читаем таблицу…');
    worker.postMessage({ ...messageData, request });
  }

  fileInput.addEventListener('change', () => {
    worker?.terminate();
    worker = undefined;
    revision++;
    file = fileInput.files[0];
    sheet.closest('label').hidden = true;
    clearResult();
    settings.hidden = true;
    rows = undefined;
    if (!file) return message();
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) return message('Выберите CSV, XLSX или XLS.', true);
    if (file.size > maxFileBytes) return message('Размер файла превышает 10 МБ.', true);
    worker = new Worker(new URL('./matrix-file-reader.js?v=file-matrix', import.meta.url));
    worker.onerror = () => message('Не удалось загрузить модуль чтения таблиц.', true);
    worker.onmessage = ({ data }) => {
      if (data.request !== revision) return;
      activeSheet = data.name;
      if (data.sheets?.length > 1) {
        sheet.replaceChildren(...data.sheets.map(name => new Option(name, name)));
        sheet.value = activeSheet;
        sheet.closest('label').hidden = false;
      }
      if (data.error) return message(data.error, true);
      const [header, ...body] = data.rows;
      const headings = header.map((name, i) => String(name ?? '').trim() || `Столбец ${i + 1}`);
      names = headings.map((name, i) => headings.indexOf(name) === headings.lastIndexOf(name) ? name : `${name} · столбец ${i + 1}`);
      rows = body;
      const numericCount = labelColumns();
      settings.hidden = false;
      message(numericCount ? `${number.format(rows.length)} строк · выберите до ${maxFactors} числовых столбцов.`
        : 'На листе нет числовых столбцов.', !numericCount);
      refresh();
    };
    load({ file });
  });

  sheet.addEventListener('change', () => load({ sheet: sheet.value }));
  columns.addEventListener('change', ({ target }) => {
    if (target.checked) selected.add(Number(target.value));
    else selected.delete(Number(target.value));
  });
  for (const control of [columns, mode, date, grain, aggregate]) control.addEventListener('change', () => {
    if (control === date) guessGrain();
    clearResult();
    message();
    refresh();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const joined = mode.value === 'atlas';
    const timeColumn = Number(date.value);
    const factorIndices = [...selected].filter(index => !joined || index !== timeColumn).sort((a, b) => a - b);
    output = fileMatrix({ rows, names, columns: factorIndices, timeColumn, grain: grain.value, method: aggregate.value,
      atlas: joined ? atlas : undefined, fileName: file.name, sheet: /\.csv$/i.test(file.name) ? undefined : activeSheet });
    const { imported } = output;
    const unit = grain.value === 'month' ? 'месяцев' : 'дней';
    const info = joined
      ? `Совпало ${number.format(imported.labels.length)} из ${number.format(imported.validPeriods)} ${unit} файла.`
      : `Строк в файле · ${number.format(imported.inputRows)}.`;
    const notes = [];
    if (!imported.labels.length) notes.push('Проверьте период атласа и формат дат.');
    if (imported.invalidDates) notes.push(`Строк без подходящей даты · ${number.format(imported.invalidDates)}.`);
    if (imported.mergedRows) notes.push(`Объединено строк за один период · ${number.format(imported.mergedRows)}.`);
    if (imported.skippedValues) notes.push(`Пустые или нечисловые значения · ${number.format(imported.skippedValues)}.`);
    message([info, ...notes].join(' '), !imported.labels.length);
    resultRoot.hidden = false;
    matrix ??= mountMatrixPanel(resultRoot, { local: true });
    matrix.loadFileResult(output);
  });

  refresh();
  return {
    setAtlas({ result, platform }) {
      if (atlasSelection?.result === result && atlasSelection?.platform === platform) return;
      atlasSelection = { result, platform };
      const series = result?.time_series;
      const ready = series?.dates?.length && Array.isArray(series.fire?.[platform]) && series.fire[platform].some(Number.isFinite);
      atlas = ready ? { result, platform } : undefined;
      if (mode.value === 'atlas' && output) {
        clearResult();
        message('Данные атласа изменились. Рассчитайте матрицу для текущих условий.');
      }
      refresh();
    },
  };
}
