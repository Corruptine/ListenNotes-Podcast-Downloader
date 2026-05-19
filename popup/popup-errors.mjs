export function getErrorMessage(error, fallbackMessage) {
  const message = typeof error === 'string' ? error : error?.message;
  return String(message || fallbackMessage || '').trim();
}

export function stripRepeatedZipFailurePrefix(message, zipFailedTemplate) {
  const value = String(message || '').trim();
  const template = String(zipFailedTemplate || '');
  const prefix = template.split('$error$')[0]?.trim();

  if (!prefix || !value.startsWith(prefix)) return value;
  return value.slice(prefix.length).replace(/^[:：\s]+/, '').trim() || value;
}
