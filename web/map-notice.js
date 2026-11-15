export function createMapNotice(host, { duration = 7000 } = {}) {
  const label = host.querySelector('[data-notice-text]') || host;
  let lastKey, timer;
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-atomic', 'true');

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    lastKey = undefined;
    label.textContent = '';
    host.hidden = true;
  }

  function show({ key, message }) {
    if (!message) return clear();
    if (key === lastKey) {
      if (!host.hidden && label.textContent !== message) label.textContent = message;
      return;
    }
    clearTimeout(timer);
    lastKey = key;
    label.textContent = message;
    host.hidden = false;
    timer = setTimeout(() => {
      host.hidden = true;
      label.textContent = '';
      timer = undefined;
    }, duration);
  }

  clear();
  return { show, clear };
}
