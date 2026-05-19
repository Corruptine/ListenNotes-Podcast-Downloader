export const SUPPORTED_LOCALES = ['en', 'zh_CN', 'ja', 'es'];
export const DEFAULT_LOCALE = 'en';

export function normalizeLocale(locale) {
  const value = String(locale || '').replace('_', '-').toLowerCase();

  if (value.startsWith('zh')) return 'zh_CN';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('en')) return 'en';

  return DEFAULT_LOCALE;
}

export function flattenChromeMessages(messages) {
  const result = {};

  for (const [key, value] of Object.entries(messages || {})) {
    if (typeof value?.message === 'string') {
      result[key] = value.message;
    }
  }

  return result;
}

export function buildTranslator(messages) {
  return (key, substitutions = {}) => {
    const template = messages?.[key];
    if (typeof template !== 'string') return key;

    return template.replace(/\$([a-zA-Z0-9_]+)\$/g, (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(substitutions, name)) return match;
      return String(substitutions[name]);
    });
  };
}

export async function loadMessages(locale, fetchJson) {
  const normalized = normalizeLocale(locale);
  const messages = await fetchJson(normalized);
  return {
    locale: normalized,
    messages: flattenChromeMessages(messages),
  };
}
