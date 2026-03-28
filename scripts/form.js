import {
  apiJson,
  copyText,
  setElementText,
  siteUrl
} from '/scripts/shared.js';

const authCard = document.getElementById('authCard');
const authForm = document.getElementById('authForm');
const authPassword = document.getElementById('authPassword');
const authNotice = document.getElementById('authNotice');
const editorCard = document.getElementById('editorCard');
const logoutButton = document.getElementById('logoutButton');
const siteForm = document.getElementById('siteForm');
const siteTitle = document.getElementById('siteTitle');
const siteFont = document.getElementById('siteFont');
const publishButton = document.getElementById('publishButton');
const resultBox = document.getElementById('resultBox');
const resultText = document.getElementById('resultText');
const resultActions = document.getElementById('resultActions');
const galleriesList = document.getElementById('galleriesList');
const galleriesStatus = document.getElementById('galleriesStatus');
const deleteSection = document.getElementById('deleteSection');
const deletePhrase = document.getElementById('deletePhrase');
const deleteConfirm = document.getElementById('deleteConfirm');
const deleteButton = document.getElementById('deleteButton');
const colorPreview = document.getElementById('colorPreview');
const colorReadout = document.getElementById('colorReadout');
const hueInput = document.getElementById('hue');
const satInput = document.getElementById('sat');
const lightInput = document.getElementById('light');
const hueValue = document.getElementById('hueValue');
const satValue = document.getElementById('satValue');
const lightValue = document.getElementById('lightValue');

const defaultState = {
  title: '',
  primaryColor: 'hsl(96 23.7% 54%)',
  fontFamily: 'serif'
};

let currentSite = null;
let allSites = [];

function showAuthCard(visible) {
  authCard.classList.toggle('hidden', !visible);
  editorCard.classList.toggle('hidden', visible);
  logoutButton.classList.toggle('hidden', visible);
}

function showAuthNotice(message, kind = '') {
  authNotice.className = kind ? `notice ${kind}` : 'notice';
  authNotice.classList.toggle('hidden', !message);
  setElementText(authNotice, message);
}

function colorString() {
  return `hsl(${hueInput.value} ${satInput.value}% ${lightInput.value}%)`;
}

function applyColorUi() {
  const color = colorString();
  document.documentElement.style.setProperty('--primary-color', color);
  colorPreview.style.background = color;
  colorReadout.textContent = color;
  hueValue.textContent = `${hueInput.value}°`;
  satValue.textContent = `${satInput.value}%`;
  lightValue.textContent = `${lightInput.value}%`;
}

function setColorFromHsl(color) {
  const match = String(color || '').match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/i);
  if (!match) {
    hueInput.value = '96';
    satInput.value = '23.7';
    lightInput.value = '54';
    applyColorUi();
    return;
  }
  hueInput.value = match[1];
  satInput.value = match[2];
  lightInput.value = match[3];
  applyColorUi();
}

function resetResult() {
  resultBox.className = 'notice hidden';
  resultBox.classList.add('hidden');
  setElementText(resultText, '');
  resultActions.innerHTML = '';
}

function renderResult(kind, message, site) {
  resultBox.className = `notice ${kind}`;
  resultBox.classList.remove('hidden');
  setElementText(resultText, message);
  resultActions.innerHTML = '';

  if (!site) return;
  const url = siteUrl(site.slug);

  const view = document.createElement('a');
  view.className = 'btn btn-primary';
  view.href = url;
  view.textContent = 'View Gallery';

  const download = document.createElement('a');
  download.className = 'btn btn-ghost';
  download.href = `/api/public/sites/${encodeURIComponent(site.slug)}/archive`;
  download.textContent = 'Download Photos';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-ghost';
  copy.textContent = 'Copy Link';
  copy.addEventListener('click', async () => {
    const ok = await copyText(url);
    copy.textContent = ok ? 'Copied' : 'Copy Failed';
    window.setTimeout(() => {
      copy.textContent = 'Copy Link';
    }, 1200);
  });

  resultActions.append(view, download, copy);
}

function resetForm() {
  currentSite = null;
  siteTitle.value = defaultState.title;
  siteFont.value = defaultState.fontFamily;
  setColorFromHsl(defaultState.primaryColor);
  history.replaceState({}, '', '/form');
  syncDeleteSection();
}

function fillForm(site) {
  currentSite = site;
  siteTitle.value = site.title;
  siteFont.value = site.fontFamily || 'serif';
  setColorFromHsl(site.primaryColor);
  history.replaceState({}, '', `/form?slug=${encodeURIComponent(site.slug)}`);
  syncDeleteSection();
}

function syncDeleteSection() {
  if (!currentSite) {
    deleteSection.classList.add('hidden');
    deleteConfirm.value = '';
    setElementText(deletePhrase, '');
    return;
  }

  deleteSection.classList.remove('hidden');
  const phrase = `delete ${currentSite.title}`;
  setElementText(deletePhrase, phrase);
  deleteConfirm.placeholder = phrase;
}

function createGalleryListItem(site) {
  const article = document.createElement('article');
  article.className = 'list-item';

  const title = document.createElement('h3');
  title.className = 'list-item-title';
  title.textContent = site.title;

  const meta = document.createElement('p');
  meta.className = 'list-item-meta';
  meta.textContent = `${site.uploadCount} upload${site.uploadCount === 1 ? '' : 's'} • ${site.slug}`;

  const actions = document.createElement('div');
  actions.className = 'cluster';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-primary';
  edit.textContent = currentSite?.slug === site.slug ? 'Editing' : 'Edit';
  edit.disabled = currentSite?.slug === site.slug;
  edit.addEventListener('click', () => {
    fillForm(site);
    resetResult();
  });

  const open = document.createElement('a');
  open.className = 'btn btn-ghost';
  open.href = siteUrl(site.slug);
  open.textContent = 'Open';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-ghost';
  copy.textContent = 'Copy Link';
  copy.addEventListener('click', async () => {
    const ok = await copyText(siteUrl(site.slug));
    copy.textContent = ok ? 'Copied' : 'Copy Failed';
    window.setTimeout(() => {
      copy.textContent = 'Copy Link';
    }, 1200);
  });

  actions.append(edit, open, copy);
  article.append(title, meta, actions);
  return article;
}

function renderGalleries() {
  galleriesList.innerHTML = '';
  if (!allSites.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No galleries yet. Publish one from the form above.';
    galleriesList.append(empty);
    setElementText(galleriesStatus, 'No galleries saved yet.');
    return;
  }

  allSites.forEach((site) => {
    galleriesList.append(createGalleryListItem(site));
  });
  setElementText(galleriesStatus, `${allSites.length} galler${allSites.length === 1 ? 'y' : 'ies'} saved locally.`);
}

async function loadGalleries() {
  const { sites } = await apiJson('/api/admin/sites');
  allSites = sites;
  const selectedSlug = new URLSearchParams(window.location.search).get('slug') || currentSite?.slug || '';
  const selected = allSites.find((site) => site.slug === selectedSlug) || allSites[0] || null;

  if (selected) {
    fillForm(selected);
  } else {
    resetForm();
  }

  renderGalleries();
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter || authForm.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    await apiJson('/api/auth/login', {
      method: 'POST',
      body: { password: authPassword.value }
    });
    authPassword.value = '';
    showAuthCard(false);
    showAuthNotice('', '');
    await loadGalleries();
  } catch (error) {
    showAuthNotice(error.message, 'notice notice-error');
  } finally {
    button.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await apiJson('/api/auth/logout', { method: 'POST' });
    showAuthCard(true);
    resetForm();
    resetResult();
  } finally {
    logoutButton.disabled = false;
  }
});

[hueInput, satInput, lightInput].forEach((input) => {
  input.addEventListener('input', applyColorUi);
});

siteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  publishButton.disabled = true;
  resetResult();

  try {
    const { site } = await apiJson('/api/admin/sites', {
      method: 'POST',
      body: {
        previousSlug: currentSite?.slug || '',
        title: siteTitle.value,
        primaryColor: colorString(),
        fontFamily: siteFont.value
      }
    });
    currentSite = site;
    renderResult('notice notice-success', `Gallery saved at ${siteUrl(site.slug)}`, site);
    await loadGalleries();
  } catch (error) {
    renderResult('notice notice-error', error.message);
  } finally {
    publishButton.disabled = false;
  }
});

deleteButton.addEventListener('click', async () => {
  if (!currentSite) return;
  const expected = `delete ${currentSite.title}`;
  if (deleteConfirm.value.trim() !== expected) {
    renderResult('notice notice-error', `Type "${expected}" exactly to confirm deletion.`);
    deleteConfirm.focus();
    return;
  }

  deleteButton.disabled = true;
  try {
    await apiJson(`/api/admin/sites/${encodeURIComponent(currentSite.slug)}`, {
      method: 'DELETE'
    });
    const deletedTitle = currentSite.title;
    resetForm();
    await loadGalleries();
    renderResult('notice notice-success', `Deleted "${deletedTitle}".`);
  } catch (error) {
    renderResult('notice notice-error', error.message);
  } finally {
    deleteButton.disabled = false;
  }
});

try {
  applyColorUi();
  const { authenticated } = await apiJson('/api/auth/status');
  showAuthCard(!authenticated);
  if (authenticated) {
    await loadGalleries();
  } else {
    showAuthNotice('Enter the admin password to unlock gallery management.', 'notice');
  }
} catch (error) {
  showAuthCard(true);
  showAuthNotice(error.message, 'notice notice-error');
}
