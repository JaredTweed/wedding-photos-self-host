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

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const unit = units[unitIndex];
  if (unit === 'GB') {
    return `${size.toFixed(1)} ${unit}`;
  }

  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${unit}`;
}

export function isAuthenticatedSession(session) {
  return Boolean(session?.isAuthenticated && session?.user);
}

export async function getSession() {
  return apiFetch('/api/auth/session');
}

export async function login({ username, password }) {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export async function register({ username, password }) {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export async function logout() {
  return apiFetch('/api/auth/logout', {
    method: 'POST'
  });
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
