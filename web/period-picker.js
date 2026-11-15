import { dateFormat } from './i18n.js';
const dayMs = 86400000;
const iso = (date) => date.toISOString().slice(0, 10);
export const addDays = (day, amount) => iso(new Date(Date.parse(day) + amount * dayMs));
export const daysBetween = (first, last) => Math.round((Date.parse(last) - Date.parse(first)) / dayMs);

export function createPeriodPicker(archive, active, onSelect, scope = document) {
  const $ = (id) => scope.querySelector('#' + id);
  const dialog = $('period-picker');
  const buttons = [...dialog.querySelectorAll('[data-period]')];
  const anchor = $('period-anchor');
  const monthInput = $('period-month');
  const yearInput = $('period-year');
  const from = $('period-start');
  const to = $('period-end');
  const shortDate = dateFormat({ dateStyle: 'medium', timeZone: 'UTC' });
  const detailedDays = archive.periodDetailDays ?? 31;
  let mode;

  function range() {
    if (mode === 'all') return [archive.first, archive.last];
    if (mode === 'custom') return from.validity.valid && to.validity.valid ? [from.value, to.value] : [];
    if (mode === 'year') return yearInput.value && yearInput.validity.valid
      ? [`${yearInput.value}-01-01`, `${yearInput.value}-12-31`] : [];
    if (mode === 'month') {
      if (!/^\d{4}-\d{2}$/.test(monthInput.value) || !monthInput.validity.valid) return [];
      const [year, month] = monthInput.value.split('-').map(Number);
      if (month < 1 || month > 12) return [];
      return [`${monthInput.value}-01`, iso(new Date(Date.UTC(year, month, 0)))];
    }
    if (!anchor.value || !anchor.validity.valid) return [];
    const day = anchor.value;
    if (mode === 'week') {
      const monday = addDays(day, -((new Date(day).getUTCDay() + 6) % 7));
      return [monday, addDays(monday, 6)];
    }
    return [day, day];
  }

  function selection() {
    const [first, last] = range();
    if (!first || !last) return;
    const start = first < archive.first ? archive.first : first;
    const end = last > archive.last ? archive.last : last;
    if (start <= end) return { start, end, mode, anchor: mode === 'week' ? anchor.value : end };
  }

  function preview() {
    const span = selection();
    $('apply-period').disabled = !span;
    const date = (day) => shortDate.format(new Date(day));
    if (!span) {
      $('period-preview').textContent = 'Укажите даты в пределах архива. Начало должно быть раньше конца или совпадать с ним.';
      return;
    }
    const count = daysBetween(span.start, span.end) + 1;
    $('period-preview').textContent = count === 1 ? date(span.start)
      : `${date(span.start)} — ${date(span.end)} · дней: ${count}${count > detailedDays ? ' · общая архивная сводка' : ''}`;
  }

  function switchMode(value) {
    mode = value;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.period === value));
    $('period-anchor-field').hidden = value !== 'day' && value !== 'week';
    $('period-month-field').hidden = value !== 'month';
    $('period-year-field').hidden = value !== 'year';
    $('period-start-field').hidden = $('period-end-field').hidden = value !== 'custom';
    $('period-fields').hidden = value === 'all';
    anchor.disabled = value !== 'day' && value !== 'week';
    monthInput.disabled = value !== 'month';
    yearInput.disabled = value !== 'year';
    from.disabled = to.disabled = value !== 'custom';
    $('period-anchor-label').textContent = value === 'week' ? 'Любой день нужной недели' : 'Дата';
    preview();
  }

  for (const input of [anchor, from, to]) {
    input.min = archive.first;
    input.max = archive.last;
    input.addEventListener('input', preview);
  }
  for (const [input, length] of [[monthInput, 7], [yearInput, 4]]) {
    input.min = archive.first.slice(0, length);
    input.max = archive.last.slice(0, length);
    input.addEventListener('input', preview);
  }
  anchor.addEventListener('change', () => {
    if (!anchor.value) return;
    monthInput.value = anchor.value.slice(0, 7);
    yearInput.value = anchor.value.slice(0, 4);
  });
  for (const button of buttons) button.addEventListener('click', () => switchMode(button.dataset.period));
  $('open-period').addEventListener('click', () => {
    const current = active();
    anchor.value = current.anchor || current.end;
    monthInput.value = current.end.slice(0, 7);
    yearInput.value = current.end.slice(0, 4);
    from.value = current.start;
    to.value = current.end;
    switchMode(current.mode);
    dialog.showModal();
  });
  $('close-period').addEventListener('click', () => dialog.close());
  $('period-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const span = selection();
    if (!span) return;
    dialog.close();
    onSelect(span);
  });
}
