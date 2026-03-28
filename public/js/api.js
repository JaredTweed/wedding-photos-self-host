const JSON_HEADERS = {
  'Content-Type': 'application/json'
};

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? JSON_HEADERS : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === 'string'
      ? payload
      : payload?.error || response.statusText;
    throw new ApiError(message || 'Request failed.', response.status, payload);
  }

  return payload;
}

export function avatarDataUri(label, { background = '#e5e7eb', color = '#111111' } = {}) {
  const letter = String(label || '?').trim().slice(0, 1).toUpperCase() || '?';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="32" fill="${background}" />
      <text x="32" y="39" text-anchor="middle" font-size="28" font-family="system-ui, sans-serif" fill="${color}">
        ${letter}
      </text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function formatTimestamp(rawValue) {
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) return '';
  const timePart = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const datePart = date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  });
  return `${timePart}, ${datePart}`;
}

export function promptForPassword() {
  const value = window.prompt('Enter the admin password.');
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export async function getSession() {
  return apiFetch('/api/auth/session');
}

export async function login(password) {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password })
  });
}

export async function logout() {
  return apiFetch('/api/auth/logout', {
    method: 'POST'
  });
}

export async function ensureAdminSession({ prompt = true } = {}) {
  const session = await getSession();
  if (session.isAdmin) return true;
  if (!prompt) return false;

  const password = promptForPassword();
  if (!password) return false;
  await login(password);
  return true;
}

export async function downloadBlob(url, fallbackName) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let message = response.statusText;
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      message = payload?.error || message;
    } else {
      message = await response.text();
    }
    throw new ApiError(message || 'Download failed.', response.status);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const matched = disposition.match(/filename="([^"]+)"/i);
  const filename = matched?.[1] || fallbackName || 'download';
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 0);
}
