export const FONT_STACKS = {
  serif: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
  sans: '"Avenir Next", "Segoe UI", Helvetica, Arial, sans-serif'
};

export function getFontStack(key) {
  return FONT_STACKS[key] || FONT_STACKS.serif;
}

export function siteUrl(slug) {
  return new URL(`/${slug}`, window.location.origin).toString();
}

export function applySiteTheme(site = {}) {
  const primaryColor = site.primaryColor || 'hsl(96 23.7% 54%)';
  const fontFamily = getFontStack(site.fontFamily);
  document.documentElement.style.setProperty('--primary-color', primaryColor);
  document.documentElement.style.setProperty('--site-font', fontFamily);
  document.body.style.fontFamily = fontFamily;
  if (site.title) {
    document.title = `${site.title} · Shared Lens`;
  }
}

export async function apiJson(url, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  const body = init.body;
  const isPlainObject =
    body &&
    typeof body === 'object' &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof ArrayBuffer);

  if (isPlainObject) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && payload.error) ||
      (typeof payload === 'string' && payload) ||
      `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function getClientId() {
  const key = 'sharedlens-client-id';
  let current = localStorage.getItem(key);
  if (!current) {
    current = crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
    localStorage.setItem(key, current);
  }
  return current;
}

export function getCreditName() {
  return localStorage.getItem('sharedlens-credit-name') || '';
}

export function setCreditName(value) {
  localStorage.setItem('sharedlens-credit-name', String(value || '').trim());
}

export function getUploadKey(slug) {
  return `sharedlens-my-uploads:${slug}`;
}

export function getMyUploads(slug) {
  try {
    const raw = localStorage.getItem(getUploadKey(slug)) || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setMyUploads(slug, uploadIds) {
  const unique = [...new Set((uploadIds || []).filter(Boolean))];
  localStorage.setItem(getUploadKey(slug), JSON.stringify(unique));
}

export function rememberUpload(slug, uploadId) {
  const uploads = getMyUploads(slug);
  uploads.push(uploadId);
  setMyUploads(slug, uploads);
}

export function forgetUpload(slug, uploadId) {
  setMyUploads(
    slug,
    getMyUploads(slug).filter((value) => value !== uploadId)
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(input);
    return ok;
  }
}

export function setElementText(target, text) {
  if (!target) return;
  target.textContent = text || '';
}
