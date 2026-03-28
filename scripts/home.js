import {
  apiJson,
  applySiteTheme,
  formatDate,
  forgetUpload,
  getClientId,
  getCreditName,
  getMyUploads,
  rememberUpload,
  setCreditName,
  setElementText
} from '/scripts/shared.js';

const slug = window.location.pathname.replace(/^\/+|\/+$/g, '');

const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const addButton = document.getElementById('addButton');
const filePicker = document.getElementById('filePicker');
const downloadButton = document.getElementById('downloadButton');
const nameButton = document.getElementById('nameButton');
const editButton = document.getElementById('editButton');
const tabAll = document.getElementById('tabAll');
const tabMine = document.getElementById('tabMine');
const panelAll = document.getElementById('panelAll');
const panelMine = document.getElementById('panelMine');
const statusNotice = document.getElementById('statusNotice');
const overlay = document.getElementById('overlay');
const overlayMedia = document.getElementById('overlayMedia');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMeta = document.getElementById('overlayMeta');
const overlayCredit = document.getElementById('overlayCredit');
const overlayDelete = document.getElementById('overlayDelete');
const overlayClose = document.getElementById('overlayClose');

const clientId = getClientId();
let authState = false;
let site = null;
let uploads = [];
let currentUpload = null;
let activeTab = localStorage.getItem(`sharedlens-active-tab:${slug}`) || 'all';
let busy = false;

function getMyUploadSet() {
  return new Set(getMyUploads(slug));
}

function isMine(upload) {
  return getMyUploadSet().has(upload.id);
}

function setStatus(message, kind = '') {
  statusNotice.className = kind ? `notice ${kind}` : 'notice';
  statusNotice.classList.toggle('hidden', !message);
  setElementText(statusNotice, message);
}

function setBusy(state, message = '') {
  busy = state;
  document.body.classList.toggle('busy', state);
  addButton.disabled = state;
  downloadButton.disabled = state;
  nameButton.disabled = state;
  if (state) {
    setStatus(message || 'Working…', 'notice notice-warning');
  } else if (message) {
    setStatus(message, 'notice notice-success');
  }
}

function createMediaCard(upload) {
  const figure = document.createElement('figure');
  figure.className = 'media-card';

  const frame = document.createElement('div');
  frame.className = 'media-frame';

  const image = document.createElement('img');
  image.src = upload.thumbUrl || upload.url;
  image.alt = upload.originalName;
  image.loading = 'lazy';

  frame.appendChild(image);

  if (upload.mediaType === 'video') {
    const badge = document.createElement('span');
    badge.className = 'media-type';
    badge.setAttribute('aria-hidden', 'true');
    frame.appendChild(badge);
  }

  const meta = document.createElement('figcaption');
  meta.className = 'media-meta';

  const title = document.createElement('p');
  title.className = 'media-name';
  title.textContent = upload.credit ? upload.credit : upload.originalName;

  const info = document.createElement('p');
  info.className = 'media-info';
  info.textContent = formatDate(upload.takenAt || upload.createdAt);

  meta.append(title, info);
  figure.append(frame, meta);

  figure.addEventListener('click', () => openOverlay(upload));
  return figure;
}

function renderPanel(panel, items, emptyText) {
  panel.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = emptyText;
    panel.append(empty);
    return;
  }

  items.forEach((upload) => {
    panel.append(createMediaCard(upload));
  });
}

function renderUploads() {
  const sorted = [...uploads].sort((a, b) => new Date(b.takenAt || b.createdAt) - new Date(a.takenAt || a.createdAt));
  const myUploads = sorted.filter(isMine);

  renderPanel(panelAll, sorted, 'No uploads yet.');
  renderPanel(panelMine, myUploads, 'Nothing uploaded from this browser yet.');

  tabAll.classList.toggle('active', activeTab === 'all');
  tabMine.classList.toggle('active', activeTab === 'mine');
  panelAll.classList.toggle('hidden', activeTab !== 'all');
  panelMine.classList.toggle('hidden', activeTab !== 'mine');
}

function closeOverlay() {
  overlay.classList.remove('visible');
  overlayMedia.innerHTML = '';
  currentUpload = null;
}

function openOverlay(upload) {
  currentUpload = upload;
  overlay.classList.add('visible');
  overlayMedia.innerHTML = '';
  setElementText(overlayTitle, upload.originalName);
  setElementText(overlayMeta, formatDate(upload.takenAt || upload.createdAt));
  setElementText(overlayCredit, upload.credit ? `Credit: ${upload.credit}` : 'Anonymous upload');

  const mine = isMine(upload) || authState;
  overlayDelete.classList.toggle('hidden', !mine);

  if (upload.mediaType === 'video') {
    const video = document.createElement('video');
    video.src = upload.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    overlayMedia.append(video);
    return;
  }

  const image = document.createElement('img');
  image.src = upload.url;
  image.alt = upload.originalName;
  overlayMedia.append(image);
}

async function deleteCurrentUpload() {
  if (!currentUpload) return;
  if (!window.confirm(`Delete "${currentUpload.originalName}"?`)) return;

  overlayDelete.disabled = true;
  try {
    await apiJson(`/api/public/sites/${encodeURIComponent(slug)}/uploads/${encodeURIComponent(currentUpload.id)}`, {
      method: 'DELETE',
      body: { clientId }
    });
    forgetUpload(slug, currentUpload.id);
    uploads = uploads.filter((upload) => upload.id !== currentUpload.id);
    renderUploads();
    closeOverlay();
    setStatus('Upload deleted.', 'notice notice-success');
  } catch (error) {
    setStatus(error.message, 'notice notice-error');
  } finally {
    overlayDelete.disabled = false;
  }
}

async function makeImageThumb(file) {
  const bitmap = await createImageBitmap(file);
  const size = 360;
  const scale = size / Math.min(bitmap.width, bitmap.height);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
}

async function makeVideoThumb(file) {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = objectUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Could not read the video.'));
    });

    const size = 360;
    const scale = size / Math.min(video.videoWidth || size, video.videoHeight || size);
    const width = Math.round((video.videoWidth || size) * scale);
    const height = Math.round((video.videoHeight || size) * scale);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.drawImage(video, (size - width) / 2, (size - height) / 2, width, height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.76));
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.remove();
  }
}

async function buildThumb(file) {
  try {
    if (String(file.type || '').startsWith('video/')) {
      return await makeVideoThumb(file);
    }
    return await makeImageThumb(file);
  } catch {
    return null;
  }
}

async function processFiles(files) {
  const selected = Array.from(files || []);
  if (!selected.length || busy) return;

  setBusy(true, `Uploading 1 / ${selected.length}…`);

  try {
    let index = 0;
    for (const file of selected) {
      index += 1;
      setStatus(`Uploading ${index} / ${selected.length}…`, 'notice notice-warning');

      const thumb = await buildThumb(file);
      const formData = new FormData();
      formData.append('file', file, file.name);
      if (thumb) {
        formData.append('thumb', thumb, 'thumb.jpg');
      }
      formData.append('clientId', clientId);
      formData.append('credit', getCreditName());
      formData.append('takenAt', new Date(file.lastModified || Date.now()).toISOString());

      const { upload } = await apiJson(`/api/public/sites/${encodeURIComponent(slug)}/uploads`, {
        method: 'POST',
        body: formData
      });

      rememberUpload(slug, upload.id);
      uploads.unshift(upload);
    }

    renderUploads();
    setBusy(false, `Uploaded ${selected.length} file${selected.length === 1 ? '' : 's'}.`);
  } catch (error) {
    setBusy(false);
    setStatus(error.message, 'notice notice-error');
  } finally {
    filePicker.value = '';
  }
}

async function loadGallery() {
  const [{ site: nextSite }, { uploads: nextUploads }, { authenticated }] = await Promise.all([
    apiJson(`/api/public/sites/${encodeURIComponent(slug)}`),
    apiJson(`/api/public/sites/${encodeURIComponent(slug)}/uploads`),
    apiJson('/api/auth/status')
  ]);

  site = nextSite;
  uploads = nextUploads;
  authState = authenticated;

  applySiteTheme(site);
  setElementText(pageTitle, site.title);
  setElementText(pageSubtitle, `${site.uploadCount} upload${site.uploadCount === 1 ? '' : 's'} so far`);
  document.title = `${site.title} · Shared Lens`;
  editButton.classList.toggle('hidden', !authenticated);
  renderUploads();
}

tabAll.addEventListener('click', () => {
  activeTab = 'all';
  localStorage.setItem(`sharedlens-active-tab:${slug}`, activeTab);
  renderUploads();
});

tabMine.addEventListener('click', () => {
  activeTab = 'mine';
  localStorage.setItem(`sharedlens-active-tab:${slug}`, activeTab);
  renderUploads();
});

filePicker.addEventListener('change', () => {
  processFiles(filePicker.files);
});

addButton.addEventListener('click', () => {
  filePicker.click();
});

downloadButton.addEventListener('click', () => {
  window.location.href = `/api/public/sites/${encodeURIComponent(slug)}/archive`;
});

nameButton.addEventListener('click', () => {
  const current = getCreditName();
  const next = window.prompt('Enter the name to attach to your uploads. Leave blank to stay anonymous.', current);
  if (next === null) return;
  setCreditName(next);
  setStatus(next.trim() ? `Uploads from this browser will be credited to ${next.trim()}.` : 'New uploads from this browser will stay anonymous.', 'notice');
  renderUploads();
});

editButton.addEventListener('click', () => {
  window.location.href = `/form?slug=${encodeURIComponent(slug)}`;
});

overlayClose.addEventListener('click', closeOverlay);
overlayDelete.addEventListener('click', deleteCurrentUpload);
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) {
    closeOverlay();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeOverlay();
  }
  const isModifier = event.ctrlKey || event.metaKey;
  if (isModifier && event.shiftKey && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    downloadButton.click();
  }
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (busy) return;
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  if (busy) return;
  const files = event.dataTransfer?.files;
  if (files?.length) {
    processFiles(files);
  }
});

try {
  if (!slug) {
    window.location.replace('/');
  } else {
    await loadGallery();
  }
} catch (error) {
  if (error.status === 404) {
    window.location.replace('/404.html');
  } else {
    setStatus(error.message, 'notice notice-error');
  }
}
