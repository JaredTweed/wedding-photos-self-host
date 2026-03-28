import { apiJson, siteUrl, setElementText } from '/scripts/shared.js';

const loginForm = document.getElementById('loginForm');
const passwordInput = document.getElementById('password');
const authNotice = document.getElementById('authNotice');
const openAdminButton = document.getElementById('openAdminButton');
const logoutButton = document.getElementById('logoutButton');
const galleryList = document.getElementById('galleryList');

function showAuthNotice(message, kind = '') {
  authNotice.className = kind ? `notice ${kind}` : 'notice';
  authNotice.classList.toggle('hidden', !message);
  setElementText(authNotice, message);
}

function setAdminState(authenticated) {
  loginForm.classList.toggle('hidden', authenticated);
  openAdminButton.classList.toggle('hidden', !authenticated);
  logoutButton.classList.toggle('hidden', !authenticated);
  if (authenticated) {
    showAuthNotice('Admin access is active on this browser.', 'notice notice-success');
  } else {
    showAuthNotice('Enter the admin password to create or edit galleries.', 'notice');
  }
}

function createGalleryItem(site) {
  const item = document.createElement('article');
  item.className = 'list-item';

  const title = document.createElement('h3');
  title.className = 'list-item-title';
  title.textContent = site.title;

  const meta = document.createElement('p');
  meta.className = 'list-item-meta';
  meta.textContent = `${site.uploadCount} upload${site.uploadCount === 1 ? '' : 's'} • Updated ${new Date(site.updatedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  })}`;

  const actions = document.createElement('div');
  actions.className = 'cluster';

  const openLink = document.createElement('a');
  openLink.className = 'btn btn-primary';
  openLink.href = siteUrl(site.slug);
  openLink.textContent = 'Open Gallery';

  const editLink = document.createElement('a');
  editLink.className = 'btn btn-ghost';
  editLink.href = `/form?slug=${encodeURIComponent(site.slug)}`;
  editLink.textContent = 'Edit';

  actions.append(openLink, editLink);
  item.append(title, meta, actions);
  return item;
}

async function loadSites() {
  const { sites } = await apiJson('/api/public/sites');
  galleryList.innerHTML = '';

  if (!sites.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No galleries have been created yet.';
    galleryList.append(empty);
    return;
  }

  sites.forEach((site) => {
    galleryList.append(createGalleryItem(site));
  });
}

async function refreshAuth() {
  const { authenticated } = await apiJson('/api/auth/status');
  setAdminState(authenticated);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = passwordInput.value;
  const button = event.submitter || loginForm.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    await apiJson('/api/auth/login', {
      method: 'POST',
      body: { password }
    });
    passwordInput.value = '';
    setAdminState(true);
    window.location.href = '/form';
  } catch (error) {
    showAuthNotice(error.message, 'notice notice-error');
  } finally {
    button.disabled = false;
  }
});

openAdminButton.addEventListener('click', () => {
  window.location.href = '/form';
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await apiJson('/api/auth/logout', { method: 'POST' });
    setAdminState(false);
  } finally {
    logoutButton.disabled = false;
  }
});

try {
  await Promise.all([refreshAuth(), loadSites()]);
} catch (error) {
  showAuthNotice(error.message, 'notice notice-error');
}
