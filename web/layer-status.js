const pending = new WeakMap();

export function setLayerBusy(input, busy, source = 'layer') {
  const label = input?.closest('label');
  if (!label) return;
  if (!pending.has(input)) pending.set(input, new Set());
  const active = pending.get(input);
  if (busy) active.add(source);
  else active.delete(source);
  busy = active.size > 0;
  let spinner = label.querySelector('.layer-loading-spinner');
  if (!spinner && busy) {
    spinner = document.createElement('span');
    spinner.className = 'fire-loading-spinner layer-loading-spinner';
    spinner.setAttribute('aria-label', 'Загрузка');
    spinner.setAttribute('role', 'status');
    label.append(spinner);
  }
  label.setAttribute('aria-busy', String(busy));
  if (spinner) spinner.hidden = !busy;
}
