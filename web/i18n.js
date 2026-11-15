const storageKey = 'nasa-space-apps-language';
const supported = new Set(['ru', 'en']);
const cyrillic = /\p{Script=Cyrillic}/u;
const whitespace = /\s+/g;
const localAttributes = ['title', 'aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'alt', 'content', 'label'];
const ignored = 'script, style, textarea, [translate="no"]';
const placeholders = /\{(\d+)\}/g;
const escapeRegex = value => value.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&');
const englishNames = new Map();
const boundaryCatalogues = new WeakSet();
const localizedFormats = new Map();
const memo = new Map();

function initialLanguage() {
  const urlLanguage = new URLSearchParams(location.search).get('lang');
  if (supported.has(urlLanguage)) return urlLanguage;
  try {
    const saved = localStorage.getItem(storageKey);
    return supported.has(saved) ? saved : 'ru';
  } catch {
    return 'ru';
  }
}

let language = initialLanguage();
document.documentElement.lang = language;
let appliedLanguage = 'ru';
let catalog;
let englishCatalog;
let patterns = [];
let revision = 0;

export function uiLanguage() {
  return language;
}

function formatter(Format, options) {
  const russian = new Format('ru', options);
  const english = new Format('en-GB', options);
  return {
    format(value) {
      const original = russian.format(value);
      const translated = english.format(value);
      if (original !== translated) {
        if (localizedFormats.size >= 8192) localizedFormats.clear();
        localizedFormats.set(original.replace(whitespace, ' '), translated);
      }
      return original;
    },
  };
}

export const numberFormat = options => formatter(Intl.NumberFormat, options);
export const dateFormat = options => formatter(Intl.DateTimeFormat, options);

function loadEnglish() {
  englishCatalog ??= import('./locale-en.js').then(({ default: translations }) => {
    const messages = new Map(Object.entries(translations));
    patterns = [...messages].flatMap(([source, target]) => {
      const slots = [...source.matchAll(placeholders)];
      if (!slots.length) return [];
      const literals = source.split(/\{\d+\}/);
      const clue = literals.filter(value => cyrillic.test(value)).sort((a, b) => b.length - a.length)[0];
      if (!clue) return [];
      const matcher = new RegExp('^' + literals.map(escapeRegex).join('(.{0,450}?)') + '$', 'u');
      return [{ clue, target, matcher, slots: slots.map(match => Number(match[1])),
        specificity: literals.reduce((sum, literal) => sum + literal.length, 0) }];
    }).sort((a, b) => b.specificity - a.specificity);
    return messages;
  }).catch(error => {
    englishCatalog = undefined;
    throw error;
  });
  return englishCatalog;
}

export function registerBoundaryNames(entries) {
  if (boundaryCatalogues.has(entries)) return;
  boundaryCatalogues.add(entries);
  for (const [name, , aliases] of entries) {
    if (!cyrillic.test(name)) continue;
    const english = aliases.find(alias => /^[\p{Script=Latin}\p{N}]/u.test(alias) && !cyrillic.test(alias));
    if (english) englishNames.set(name, english);
  }
  memo.clear();
}

function substitute(text, depth) {
  const exact = catalog.get(text) ?? englishNames.get(text) ?? localizedFormats.get(text);
  if (exact) return exact;
  if (depth > 6 || text.length > 1600) return text;
  let partial = text;
  for (const { clue, target, matcher, slots } of patterns) {
    if (!text.includes(clue)) continue;
    const match = matcher.exec(text);
    if (!match) continue;
    const translated = target.replace(placeholders, (_, key) => {
      const raw = match[slots.indexOf(Number(key)) + 1];
      return raw === undefined ? '' : substitute(raw.trim(), depth + 1);
    });
    if (!cyrillic.test(translated)) return translated;
    if (partial === text && translated !== text) partial = translated;
  }
  const segments = text.split(/( · | — | × | \/ | ↔ | \| | \(|\)$)/u);
  if (segments.length > 1) {
    const translated = segments.map(part => cyrillic.test(part) || localizedFormats.has(part) ? substitute(part, depth + 1) : part).join('');
    if (!cyrillic.test(translated) || partial === text) return translated;
  }
  const sentence = text.match(/^(.*?)(?:([.!?])$)/s);
  if (sentence) {
    const short = catalog.get(sentence[1]) ?? englishNames.get(sentence[1]);
    if (short) return short + sentence[2];
  }
  return partial;
}

export function translate(value) {
  if (!catalog || language !== 'en' || typeof value !== 'string') return value;
  const key = value.replace(whitespace, ' ').trim();
  const direct = localizedFormats.get(key);
  if (!direct && !cyrillic.test(value)) return value;
  const translated = direct ?? memo.get(key) ?? substitute(key, 0);
  if (memo.size >= 4096) memo.clear();
  memo.set(key, translated);
  return translated === key ? value : value.match(/^\s*/)[0] + translated + value.match(/\s*$/)[0];
}

const textSources = new WeakMap();
const attributeSources = new WeakMap();
const protectedTerms = new WeakMap();
const inputSources = new WeakMap();

// Only values supplied by the app are localized. An edit belongs to the user.
export function setLocalizedInputValue(input, source) {
  const rendered = translate(source);
  input.value = rendered;
  inputSources.set(input, { source, rendered });
}

export function protectLocaleText(node, terms) {
  if (terms.length) {
    const unique = [...new Set(terms)].sort((a, b) => b.length - a.length);
    protectedTerms.set(node, { terms: unique, matches: new RegExp(unique.map(escapeRegex).join('|'), 'gu') });
  } else protectedTerms.delete(node);
  return node;
}

function translateProtected(value, element) {
  const protectedText = protectedTerms.get(element);
  if (language !== 'en' || !protectedText) return translate(value);
  const { terms, matches } = protectedText;
  const tokens = value.replace(matches, term => `\uE000${terms.indexOf(term)}\uE001`);
  return translate(tokens).replace(/\uE000(\d+)\uE001/g, (_, index) => terms[Number(index)]);
}

function translateValue(value, previous, write, render = translate) {
  const source = previous?.rendered === value ? previous.source : value;
  const rendered = render(source);
  if (value !== rendered) write(rendered);
  return rendered !== source ? { source, rendered } : undefined;
}

function jsonDisplay(source) {
  if (language !== 'en' || !cyrillic.test(source)) return source;
  try {
    const value = JSON.parse(source);
    const display = JSON.parse(JSON.stringify(value, (key, item) =>
      ['fileName', 'sheet', 'timeColumn'].includes(key) ? item : translate(item)));
    return JSON.stringify(display, null, 2);
  } catch {
    return translate(source);
  }
}

function translateText(node) {
  if (!node.parentElement?.closest(ignored)) {
    const render = node.parentElement?.closest('pre') ? jsonDisplay : value => translateProtected(value, node.parentElement);
    const saved = translateValue(node.data, textSources.get(node), text => { node.data = text; }, render);
    if (saved) textSources.set(node, saved);
    else textSources.delete(node);
  }
}

function translateAttribute(element, attr) {
  const value = element.getAttribute(attr);
  const previous = attributeSources.get(element);
  if (value === null) {
    previous?.delete(attr);
    return;
  }
  const saved = translateValue(value, previous?.get(attr), text => element.setAttribute(attr, text),
    source => translateProtected(source, element));
  if (saved) {
    if (!previous) attributeSources.set(element, new Map([[attr, saved]]));
    else previous.set(attr, saved);
  } else previous?.delete(attr);
}

export function localizeTree(node) {
  if (node.nodeType === Node.TEXT_NODE) return translateText(node);
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.closest(ignored)) return;
    const input = inputSources.get(node);
    if (input) {
      if (node.value === input.rendered) setLocalizedInputValue(node, input.source);
      else inputSources.delete(node);
    }
    for (const attr of localAttributes) if (node.hasAttribute(attr)) translateAttribute(node, attr);
  }
  for (const child of node.childNodes) localizeTree(child);
}

const observer = new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') {
      if (!record.target.closest(ignored)) translateAttribute(record.target, record.attributeName);
    } else if (record.type === 'characterData') {
      translateText(record.target);
    } else {
      for (const node of record.addedNodes) localizeTree(node);
    }
  }
});

export function preserveLanguage(url) {
  url.searchParams.set('lang', language);
  return url;
}

export function initializeLocalization() {
  const sync = () => {
    for (const button of document.querySelectorAll('.app-language [data-language]')) {
      button.setAttribute('aria-pressed', String(button.dataset.language === appliedLanguage));
    }
  };
  async function change(next, explicit) {
    if (!supported.has(next)) return;
    const token = ++revision;
    try {
      if (next === 'en') catalog = await loadEnglish();
      if (token !== revision) return;
      observer.disconnect();
      language = appliedLanguage = next;
      document.documentElement.lang = next;
      if (explicit) {
        try { localStorage.setItem(storageKey, next); } catch { /* Storage can be disabled. */ }
        history.replaceState(history.state, '', preserveLanguage(new URL(location.href)));
      }
      sync();
      localizeTree(document.documentElement);
      if (next === 'en') observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: localAttributes,
      });
    } catch (error) {
      if (token !== revision) return;
      language = appliedLanguage;
      document.documentElement.lang = language;
      sync();
      console.error('Could not load the English interface.', error);
    }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.app-language [data-language]');
    if (button) change(button.dataset.language, true);
  });
  window.addEventListener('popstate', () => history.replaceState(history.state, '', preserveLanguage(new URL(location.href))));
  return change(language, false);
}
