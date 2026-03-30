import { apiFetch, formatBytes, getSession, isAuthenticatedSession, logout } from '/js/api.js?v=20260330-2';

const sessionLabel = document.getElementById('sessionLabel');
const totalUsed = document.getElementById('totalUsed');
const totalCapacity = document.getElementById('totalCapacity');
const remainingAvailable = document.getElementById('remainingAvailable');
const unassignedNote = document.getElementById('unassignedNote');
const userRows = document.getElementById('userRows');
const mainButton = document.getElementById('mainButton');
const editorButton = document.getElementById('editorButton');
const signOutButton = document.getElementById('signOutButton');
const REFRESH_INTERVAL_MS = 5000;

let refreshTimer = null;
let refreshInFlight = false;

function renderUsers(users) {
  userRows.innerHTML = '';

  if (!Array.isArray(users) || !users.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No accounts exist yet.';
    userRows.appendChild(empty);
    return;
  }

  for (const user of users) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const nameCell = document.createElement('div');
    nameCell.className = 'user-cell user-cell-primary';
    nameCell.dataset.label = 'User';
    const nameValue = document.createElement('div');
    nameValue.className = 'user-name';
    nameValue.textContent = user.username;
    nameCell.appendChild(nameValue);

    const siteCountCell = document.createElement('div');
    siteCountCell.className = 'user-cell';
    siteCountCell.dataset.label = 'Sites';
    siteCountCell.textContent = String(user.siteCount || 0);

    const uploadCountCell = document.createElement('div');
    uploadCountCell.className = 'user-cell';
    uploadCountCell.dataset.label = 'Uploads';
    uploadCountCell.textContent = String(user.uploadCount || 0);

    const bytesCell = document.createElement('div');
    bytesCell.className = 'user-cell';
    bytesCell.dataset.label = 'Used';
    bytesCell.textContent = formatBytes(user.bytesUsed);

    row.append(nameCell, siteCountCell, uploadCountCell, bytesCell);
    userRows.appendChild(row);
  }
}

async function refreshStorage({ redirectOnAuthFailure = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    const payload = await apiFetch('/api/users/storage');
    renderUsers(payload.users || []);

    totalUsed.textContent = formatBytes(payload.totals?.appBytesUsed);
    totalCapacity.textContent = payload.totals?.storageBytesTotal == null
      ? 'Unavailable'
      : formatBytes(payload.totals.storageBytesTotal);
    remainingAvailable.textContent = payload.totals?.storageBytesRemaining == null
      ? 'Unavailable'
      : formatBytes(payload.totals.storageBytesRemaining);

    if (payload.totals?.unassignedBytesUsed > 0) {
      unassignedNote.style.display = 'block';
      unassignedNote.textContent = `${formatBytes(payload.totals.unassignedBytesUsed)} is currently stored outside any user-owned site, so it is included in Total Used but not assigned to a user row.`;
    } else {
      unassignedNote.style.display = 'none';
      unassignedNote.textContent = '';
    }
  } catch (error) {
    if (redirectOnAuthFailure && error?.status === 401) {
      window.location.replace('/');
      return;
    }
    console.error(error);
  } finally {
    refreshInFlight = false;
  }
}

function startLiveRefresh() {
  stopLiveRefresh();
  refreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    refreshStorage();
  }, REFRESH_INTERVAL_MS);
}

function stopLiveRefresh() {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function init() {
  const session = await getSession();
  if (!isAuthenticatedSession(session)) {
    window.location.replace('/');
    return;
  }

  sessionLabel.textContent = `Signed in as ${session.user.username}`;
  await refreshStorage({ redirectOnAuthFailure: true });
  startLiveRefresh();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshStorage();
    }
  });
  window.addEventListener('beforeunload', stopLiveRefresh);
}

mainButton.addEventListener('click', () => {
  window.location.href = '/';
});

editorButton.addEventListener('click', () => {
  window.location.href = '/form';
});

signOutButton.addEventListener('click', async () => {
  try {
    await logout();
    window.location.href = '/';
  } catch (error) {
    alert(error.message || 'Sign-out failed.');
  }
});

init().catch((error) => {
  console.error(error);
  alert(error.message || 'Could not load storage usage.');
});
