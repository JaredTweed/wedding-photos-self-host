import { apiFetch, downloadBlob, formatTimestamp } from '/js/api.js?v=20260330-2';

const FONT_OPTIONS = {
  serif: `Georgia, "Times New Roman", serif`,
  sans: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
};

const THUMB_SIZE = 330;

const loader = document.getElementById('loader');
const dateIndicator = document.getElementById('dateIndicator');
const picker = document.getElementById('filePicker');
const addBtn = document.getElementById('addBtn');
const settingsBtn = document.getElementById('settingsBtn');
const icon = document.getElementById('settingsIcon');
const panelAll = document.getElementById('panelAll');
const panelMine = document.getElementById('panelMine');
const tabAll = document.getElementById('tabAll');
const tabMine = document.getElementById('tabMine');
const toolbar = document.getElementById('selectionToolbar');
const btnDelete = document.getElementById('deleteSelected');
const btnDeselect = document.getElementById('deselectAll');
const overlay = document.getElementById('overlay');
const overlayContent = document.getElementById('overlayContent');
const overlayBottom = document.getElementById('overlayBottom');
const overlayBtn = document.getElementById('overlayBtn');
const timestampEl = document.getElementById('timestamp');
const creditEl = document.querySelector('.credit');
const progressTemplate = document.getElementById('progress-row-template');

let site = null;
let uploads = [];
let currentUpload = null;
let uploading = false;
let downloadAllInProgress = false;
let selectedIds = new Set();
let indicatorTimeout = null;
let scrollFramePending = false;
let figureRefsByUploadId = new Map();

const initialPath = window.location.pathname.replace(/^\/+|\/+$/g, '');
const currentSlug = initialPath;

const activeTabStorageKey = `sharedlens_active_tab_${currentSlug}`;
const creditStorageKey = `sharedlens_credit_${currentSlug}`;
let creditName = localStorage.getItem(creditStorageKey) || '';

function showLoader(show) {
  loader.style.display = show ? 'flex' : 'none';
}

function setTheme(config) {
  document.documentElement.style.setProperty('--primary-color', config.primaryColor);
  document.documentElement.style.setProperty('--secondary-color', secondaryColor(config.primaryColor));
  document.documentElement.style.setProperty('--site-font', FONT_OPTIONS[config.fontFamily] || FONT_OPTIONS.serif);
  document.body.style.fontFamily = FONT_OPTIONS[config.fontFamily] || FONT_OPTIONS.serif;
  document.title = config.title;
  document.getElementById('page-title').textContent = config.title;
}

function secondaryColor(primaryHsl) {
  const match = String(primaryHsl || '').match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/i);
  if (!match) return 'hsl(96 21% 94%)';
  const hue = Number.parseFloat(match[1]);
  const sat = Number.parseFloat(match[2]);
  const light = Number.parseFloat(match[3]);
  return `hsl(${hue} ${sat}% ${Math.max(94, (light + 100) / 2)}%)`;
}

function getActivePanel() {
  return document.querySelector('.tab-panel.active');
}

function switchTab(showAll) {
  tabAll.classList.toggle('active', showAll);
  tabMine.classList.toggle('active', !showAll);
  panelAll.classList.toggle('active', showAll);
  panelMine.classList.toggle('active', !showAll);
  localStorage.setItem(activeTabStorageKey, showAll ? 'all' : 'mine');
  dateIndicator.style.opacity = '0';
  updateToolbar();
  updatePanelMessages();
}

function restoreTab() {
  const saved = localStorage.getItem(activeTabStorageKey);
  switchTab(saved === 'all');
}

function showDateIndicator(text) {
  dateIndicator.textContent = text;
  dateIndicator.style.opacity = '1';
  clearTimeout(indicatorTimeout);
  indicatorTimeout = setTimeout(() => {
    dateIndicator.style.opacity = '0';
  }, 1000);
}

function onScroll() {
  if (overlay.classList.contains('visible') || scrollFramePending) return;
  scrollFramePending = true;
  window.requestAnimationFrame(() => {
    scrollFramePending = false;
    const panel = getActivePanel();
    if (!panel) return;

    for (const fig of panel.querySelectorAll('figure')) {
      const rect = fig.getBoundingClientRect();
      if (rect.top + (rect.height / 2) >= 100) {
        showDateIndicator(formatTimestamp(Number(fig.dataset.taken)));
        break;
      }
    }
  });
}

function updatePanelMessages() {
  for (const panel of [panelAll, panelMine]) {
    const figures = panel.querySelectorAll('figure');
    if (!figures.length) {
      if (!panel.querySelector('.empty-message')) {
        panel.innerHTML = `<p class="empty-message">No uploads yet</p>`;
      }
    } else {
      panel.querySelector('.empty-message')?.remove();
    }
  }
}

function updateToolbar() {
  const count = selectedIds.size;
  if (!count) {
    toolbar.style.display = 'none';
    btnDelete.textContent = 'Delete';
    return;
  }
  toolbar.style.display = 'flex';
  btnDelete.textContent = `Delete (${count})`;
}

function clearSelection() {
  const selected = Array.from(selectedIds);
  selectedIds = new Set();
  for (const uploadId of selected) {
    for (const figure of figureRefsByUploadId.get(uploadId) || []) {
      figure.classList.remove('selected');
    }
  }
  updateToolbar();
}

function toggleSelection(uploadId) {
  if (selectedIds.has(uploadId)) {
    selectedIds.delete(uploadId);
  } else {
    selectedIds.add(uploadId);
  }

  for (const figure of figureRefsByUploadId.get(uploadId) || []) {
    figure.classList.toggle('selected', selectedIds.has(uploadId));
  }
  updateToolbar();
}

function renderPanels() {
  clearSelection();
  figureRefsByUploadId = new Map();

  const allFragment = document.createDocumentFragment();
  const mineFragment = document.createDocumentFragment();

  for (const upload of uploads) {
    allFragment.appendChild(buildFigure(upload, { selectable: false }));
    if (upload.isMine) {
      mineFragment.appendChild(buildFigure(upload, { selectable: true }));
    }
  }

  panelAll.replaceChildren(allFragment);
  panelMine.replaceChildren(mineFragment);
  updatePanelMessages();
}

function rememberFigure(uploadId, figure) {
  const figures = figureRefsByUploadId.get(uploadId) || [];
  figures.push(figure);
  figureRefsByUploadId.set(uploadId, figures);
}

function buildFigure(upload, { selectable }) {
  const figure = document.createElement('figure');
  figure.dataset.id = upload.id;
  figure.dataset.taken = String(new Date(upload.takenAt || upload.createdAt).getTime());
  rememberFigure(upload.id, figure);

  const thumb = document.createElement('img');
  thumb.src = upload.thumbnailUrl || upload.mediaUrl;
  thumb.loading = 'lazy';
  thumb.decoding = 'async';
  thumb.fetchPriority = 'low';
  thumb.draggable = false;
  figure.appendChild(thumb);

  if (upload.isVideo) {
    const iconEl = document.createElement('div');
    iconEl.className = 'video-icon';
    figure.appendChild(iconEl);
  }

  if (selectable) {
    const box = document.createElement('div');
    box.className = 'select-box';
    figure.appendChild(box);
  }

  wireFigureHandlers(figure, upload, selectable);
  return figure;
}

function wireFigureHandlers(figure, upload, selectable) {
  figure.addEventListener('contextmenu', (event) => event.preventDefault());

  let longPress = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let timer = null;

  const clearTimer = () => clearTimeout(timer);

  if (selectable) {
    figure.addEventListener('pointerdown', (event) => {
      startX = event.clientX;
      startY = event.clientY;
      moved = false;
      longPress = false;

      timer = setTimeout(() => {
        longPress = true;
        toggleSelection(upload.id);
      }, 450);
    });

    figure.addEventListener('pointermove', (event) => {
      if (moved) return;
      const dx = Math.abs(event.clientX - startX);
      const dy = Math.abs(event.clientY - startY);
      if (dx > 8 || dy > 8) {
        moved = true;
        clearTimer();
      }
    });

    figure.addEventListener('pointercancel', clearTimer);
  }

  figure.addEventListener('pointerup', (event) => {
    clearTimer();
    if (longPress || moved) return;

    if (selectable && (event.target.className === 'select-box' || selectedIds.size > 0)) {
      toggleSelection(upload.id);
      return;
    }

    openOverlay(upload);
  });
}

function openOverlay(upload) {
  currentUpload = upload;
  overlayContent.innerHTML = '';
  creditEl.textContent = upload.creditName ? `Credit: ${upload.creditName}` : '';
  timestampEl.textContent = formatTimestamp(upload.takenAt || upload.createdAt);

  const media = upload.isVideo
    ? Object.assign(document.createElement('video'), { controls: true, preload: 'metadata', playsInline: true })
    : document.createElement('img');
  media.src = upload.mediaUrl;
  overlayContent.appendChild(media);

  overlayBottom.style.display = 'flex';
  overlayBtn.style.display = upload.isMine ? 'block' : 'none';
  overlay.classList.add('visible');
  history.pushState({ view: 'overlay' }, '');
}

function closeOverlay({ fromHistory = false } = {}) {
  if (!overlay.classList.contains('visible')) return;
  const video = overlayContent.querySelector('video');
  if (video) {
    video.pause();
    video.currentTime = 0;
  }

  overlay.classList.remove('visible');
  overlayBottom.style.display = 'none';
  overlayContent.innerHTML = '';
  currentUpload = null;

  if (!fromHistory && history.state?.view === 'overlay') {
    history.back();
  }
}

function makeProgressRow(name) {
  const row = progressTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.label').textContent = name;
  overlayContent.appendChild(row);
  return {
    reset(nextName) {
      row.classList.remove('finish');
      row.querySelector('.label').textContent = nextName || '';
      row.querySelector('progress').value = 0;
    },
    setPercent(value) {
      row.querySelector('progress').value = value;
    },
    finish() {
      row.classList.add('finish');
      row.querySelector('progress').value = 100;
    }
  };
}

async function makeImageThumb(file) {
  const bitmap = await createImageBitmap(file);
  const scale = THUMB_SIZE / Math.min(bitmap.width, bitmap.height);
  const scaledWidth = Math.round(bitmap.width * scale);
  const scaledHeight = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;
  const context = canvas.getContext('2d');
  const offsetX = (scaledWidth - THUMB_SIZE) / 2;
  const offsetY = (scaledHeight - THUMB_SIZE) / 2;
  context.drawImage(bitmap, -offsetX, -offsetY, scaledWidth, scaledHeight);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not create image thumbnail.'));
        return;
      }
      resolve(blob);
    }, 'image/jpeg', 0.72);
  });
}

async function makeVideoThumb(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Could not load video for thumbnail.'));
    });
    video.currentTime = 0;
    await new Promise((resolve, reject) => {
      video.onseeked = resolve;
      video.onerror = () => reject(new Error('Could not seek video for thumbnail.'));
    });

    const scale = THUMB_SIZE / Math.min(video.videoWidth || THUMB_SIZE, video.videoHeight || THUMB_SIZE);
    const scaledWidth = Math.round((video.videoWidth || THUMB_SIZE) * scale);
    const scaledHeight = Math.round((video.videoHeight || THUMB_SIZE) * scale);

    const canvas = document.createElement('canvas');
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const context = canvas.getContext('2d');
    const offsetX = (scaledWidth - THUMB_SIZE) / 2;
    const offsetY = (scaledHeight - THUMB_SIZE) / 2;
    context.drawImage(video, -offsetX, -offsetY, scaledWidth, scaledHeight);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Could not create video thumbnail.'));
          return;
        }
        resolve(blob);
      }, 'image/jpeg', 0.72);
    });
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function isVideoFile(file) {
  return /^video\//i.test(file.type || '') || /\.(mp4|mov|webm)$/i.test(file.name || '');
}

function uploadSingleFile(file, thumbBlob, progressCallback) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    if (thumbBlob) {
      formData.append('thumbnail', thumbBlob, `${file.name}.jpg`);
    }
    formData.append('takenAt', new Date(file.lastModified || Date.now()).toISOString());
    formData.append('creditName', creditName);

    const request = new XMLHttpRequest();
    request.open('POST', `/api/sites/${encodeURIComponent(site.slug)}/uploads`);
    request.responseType = 'json';

    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      progressCallback(Math.round((event.loaded / event.total) * 100));
    });

    request.addEventListener('load', () => {
      const payload = request.response || JSON.parse(request.responseText || '{}');
      if (request.status >= 200 && request.status < 300 && payload.upload) {
        resolve(payload.upload);
        return;
      }
      reject(new Error(payload.error || 'Upload failed.'));
    });

    request.addEventListener('error', () => {
      reject(new Error('Upload failed.'));
    });

    request.send(formData);
  });
}

async function processSelectedFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length || uploading) return;

  uploading = true;
  addBtn.textContent = 'Uploading...';
  overlay.classList.add('visible');
  overlayBottom.style.display = 'none';
  overlayContent.innerHTML = '';

  const statusEl = document.createElement('div');
  statusEl.style.color = '#fff';
  statusEl.style.fontSize = '1.2rem';
  statusEl.style.textAlign = 'center';
  statusEl.style.padding = '1rem';
  statusEl.textContent = `Uploading 1 / ${files.length}…`;
  overlayContent.appendChild(statusEl);

  const row = makeProgressRow(files[0]?.name || '');

  try {
    for (const [index, file] of files.entries()) {
      row.reset(file.name);
      const thumbBlob = isVideoFile(file)
        ? await makeVideoThumb(file)
        : await makeImageThumb(file);

      const upload = await uploadSingleFile(file, thumbBlob, (percent) => {
        row.setPercent(percent);
      });
      row.finish();

      statusEl.textContent = `Uploading ${Math.min(index + 2, files.length)} / ${files.length}…`;
      uploads.unshift(upload);
    }

    overlayContent.innerHTML = `
      <div style="color:#fff;font-size:1.2rem;text-align:center;padding:1rem;">
        Uploaded ${files.length} / ${files.length}<br>Success!!
      </div>
    `;
    await new Promise((resolve) => setTimeout(resolve, 900));
    renderPanels();
  } catch (error) {
    console.error(error);
    alert(error.message || 'Upload failed.');
  } finally {
    uploading = false;
    addBtn.textContent = 'Add Photos / Videos';
    overlay.classList.remove('visible');
    overlayBottom.style.display = 'none';
    overlayContent.innerHTML = '';
    if (picker) picker.value = '';
  }
}

async function refreshUploads() {
  const payload = await apiFetch(`/api/sites/${encodeURIComponent(site.slug)}/uploads`);
  uploads = Array.isArray(payload.uploads) ? payload.uploads : [];
  renderPanels();
}

async function updateCreditName() {
  const response = window.prompt(
    'Enter your name if you want others to know which uploads are yours. Leave blank if you wish to remain anonymous.',
    creditName || ''
  );
  if (response == null) return;

  icon.classList.add('spinning');
  try {
    creditName = response.trim();
    localStorage.setItem(creditStorageKey, creditName);
    await apiFetch(`/api/sites/${encodeURIComponent(site.slug)}/credit`, {
      method: 'POST',
      body: JSON.stringify({ creditName })
    });
    uploads = uploads.map((upload) => (
      upload.isMine
        ? { ...upload, creditName }
        : upload
    ));
    if (currentUpload?.isMine) {
      currentUpload.creditName = creditName;
      creditEl.textContent = creditName ? `Credit: ${creditName}` : '';
    }
  } catch (error) {
    alert(error.message || 'Could not update upload credits.');
  } finally {
    icon.classList.remove('spinning');
  }
}

async function deleteUploads(ids) {
  const targets = ids.filter(Boolean);
  if (!targets.length) return;
  const targetSet = new Set(targets);

  await Promise.all(targets.map((id) => apiFetch(
    `/api/sites/${encodeURIComponent(site.slug)}/uploads/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  )));

  uploads = uploads.filter((upload) => !targetSet.has(upload.id));
  renderPanels();
}

async function deleteSelectedUploads() {
  const ids = Array.from(selectedIds);
  if (!ids.length) return;
  if (!window.confirm(`Are you sure you want to delete ${ids.length} file${ids.length === 1 ? '' : 's'}?`)) {
    return;
  }

  btnDelete.disabled = true;
  btnDelete.textContent = 'Deleting…';
  try {
    await deleteUploads(ids);
  } catch (error) {
    alert(error.message || 'Could not delete the selected uploads.');
  } finally {
    btnDelete.disabled = false;
    updateToolbar();
  }
}

async function deleteCurrentUpload() {
  if (!currentUpload?.isMine) return;
  if (!window.confirm('Are you sure you want to delete this file?')) return;

  overlayBtn.disabled = true;
  overlayBtn.textContent = 'Deleting…';
  try {
    await deleteUploads([currentUpload.id]);
    closeOverlay();
  } catch (error) {
    alert(error.message || 'Could not delete the file.');
  } finally {
    overlayBtn.disabled = false;
    overlayBtn.textContent = 'Delete';
  }
}

async function downloadAllFullRes() {
  if (downloadAllInProgress) return;
  downloadAllInProgress = true;
  showLoader(true);
  try {
    await downloadBlob(`/api/sites/${encodeURIComponent(site.slug)}/download`, `${site.slug}-originals.zip`);
  } catch (error) {
    alert(error.message || 'Could not prepare the download.');
  } finally {
    downloadAllInProgress = false;
    showLoader(false);
  }
}

function bindGlobalEvents() {
  history.replaceState({ view: 'main' }, '');

  tabAll.addEventListener('pointerdown', () => switchTab(true));
  tabMine.addEventListener('pointerdown', () => switchTab(false));
  settingsBtn.addEventListener('click', updateCreditName);
  picker.addEventListener('change', (event) => processSelectedFiles(event.target.files));
  overlayBtn.addEventListener('click', deleteCurrentUpload);
  btnDelete.addEventListener('click', deleteSelectedUploads);
  btnDeselect.addEventListener('click', clearSelection);

  overlay.addEventListener('pointerup', (event) => {
    if (uploading) return;
    if (event.target === overlay) {
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
    }
  });

  panelAll.addEventListener('scroll', onScroll);
  panelMine.addEventListener('scroll', onScroll);

  window.addEventListener('popstate', () => {
    if (overlay.classList.contains('visible')) {
      closeOverlay({ fromHistory: true });
    }
  });

  window.addEventListener('keydown', (event) => {
    if (uploading && event.key === 'Escape') return;
    if (event.key === 'Escape') {
      closeOverlay();
      return;
    }

    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      downloadAllFullRes();
      return;
    }

    if (modifier && event.key.toLowerCase() === 'a') {
      const activePanel = getActivePanel();
      if (!activePanel || activePanel !== panelMine) return;
      event.preventDefault();
      activePanel.querySelectorAll('figure[data-id]').forEach((figure) => {
        const uploadId = figure.dataset.id;
        if (!selectedIds.has(uploadId)) {
          toggleSelection(uploadId);
        }
      });
    }
  });

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  let dragDepth = 0;

  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event) || uploading) return;
    dragDepth += 1;
    document.body.classList.add('drag-over');
  });

  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = uploading ? 'none' : 'copy';
  });

  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      document.body.classList.remove('drag-over');
    }
  });

  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drag-over');
    if (uploading) return;
    processSelectedFiles(event.dataTransfer?.files || []);
  });
}

async function init() {
  bindGlobalEvents();
  restoreTab();
  showLoader(true);

  try {
    const payload = await apiFetch(`/api/sites/${encodeURIComponent(currentSlug)}`);
    site = payload.site;
    setTheme(site);
    await refreshUploads();
  } catch (error) {
    console.error(error);
    window.location.replace('/404.html');
    return;
  } finally {
    showLoader(false);
  }
}

init();
