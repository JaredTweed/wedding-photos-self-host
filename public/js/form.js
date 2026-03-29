import {
  apiFetch,
  avatarDataUri,
  downloadBlob,
  getSession,
  isAuthenticatedSession,
  logout
} from '/js/api.js';

const DEFAULT_FONT_KEY = 'serif';

let editingSite = null;
let deleteConfirmPhrase = '';
let currentSession = { isAuthenticated: false, user: null };

const formEl = document.getElementById('siteForm');
const userbar = document.getElementById('sl-userbar');
const avatarEl = document.getElementById('sl-user-avatar');
const menuEl = document.getElementById('sl-user-menu');
const mainBtn = document.getElementById('sl-main');
const authBtn = document.getElementById('sl-auth');
const siteTitleInput = document.getElementById('siteTitle');
const siteFontSelect = document.getElementById('siteFont');
const publishButton = document.getElementById('publishButton');
const donationGate = document.getElementById('donationGate');
const donationGateText = document.getElementById('donationGateText');
const siteResult = document.getElementById('siteResult');
const deleteSection = document.getElementById('deleteSiteSection');
const deletePhraseEl = document.getElementById('deleteSitePhrase');
const deleteInput = document.getElementById('deleteSiteConfirm');
const deleteButton = document.getElementById('deleteSiteButton');

const params = new URLSearchParams(window.location.search);
const rawSlugParam = String(params.get('slug') || '').trim().toLowerCase();
const slugParam = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawSlugParam) ? rawSlugParam : '';

function resolveFontKey(value) {
  return value === 'sans' ? 'sans' : DEFAULT_FONT_KEY;
}

function hsl() {
  const hue = document.getElementById('hue').value;
  const sat = document.getElementById('sat').value;
  const light = document.getElementById('light').value;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function updateColor() {
  const hue = document.getElementById('hue').value;
  const sat = document.getElementById('sat').value;
  const light = document.getElementById('light').value;
  const color = `hsl(${hue} ${sat}% ${light}%)`;

  document.documentElement.style.setProperty('--primary', color);
  document.documentElement.style.setProperty('--current-hue', hue);
  document.documentElement.style.setProperty('--current-sat', sat);
  document.documentElement.style.setProperty('--current-light', light);
  document.getElementById('hslValue').textContent = color;
  document.getElementById('colorPreviewLarge').style.background = color;
  document.getElementById('hueValue').textContent = `${hue}°`;
  document.getElementById('satValue').textContent = `${sat}%`;
  document.getElementById('lightValue').textContent = `${light}%`;
  updateHueGradient(sat, light);

  document.getElementById('sat').style.background = `linear-gradient(to right,
    hsl(${hue}, 0%, 50%) 0%,
    hsl(${hue}, 100%, 50%) 100%)`;

  document.getElementById('light').style.background = `linear-gradient(to right,
    hsl(${hue}, ${sat}%, 0%) 0%,
    hsl(${hue}, ${sat}%, 50%) 50%,
    hsl(${hue}, ${sat}%, 100%) 100%)`;
}

function updateHueGradient(sat, light) {
  const canvas = document.getElementById('hueGradientCanvas');
  const context = canvas.getContext('2d');
  for (let x = 0; x < canvas.width; x += 1) {
    context.fillStyle = `hsl(${x} ${sat}% ${light}%)`;
    context.fillRect(x, 0, 1, 1);
  }
  const hueSlider = document.querySelector('.hue');
  hueSlider.style.backgroundImage = `url(${canvas.toDataURL()})`;
  hueSlider.style.backgroundSize = '100% 100%';
  hueSlider.style.backgroundRepeat = 'no-repeat';
}

function installRangeGuards() {
  const sliders = document.querySelectorAll('input[type="range"]');
  const threshold = 8;

  for (const slider of sliders) {
    let startX = 0;
    let startY = 0;
    let startValue = slider.value;

    slider.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      startX = event.clientX;
      startY = event.clientY;
      startValue = slider.value;
      slider.dataset.touchGuard = 'pending';
    }, { passive: true });

    slider.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch') return;
      const guardState = slider.dataset.touchGuard;
      if (!guardState || guardState === 'allowed') return;

      const dx = Math.abs(event.clientX - startX);
      const dy = Math.abs(event.clientY - startY);

      if (guardState === 'pending') {
        if (dy > dx && dy > threshold) {
          slider.dataset.touchGuard = 'blocked';
          slider.value = startValue;
          updateColor();
          slider.blur();
          return;
        }
        if (dx > threshold) {
          slider.dataset.touchGuard = 'allowed';
        }
      }
    }, { passive: true });

    const cleanup = () => {
      slider.dataset.touchGuard = '';
    };

    slider.addEventListener('pointerup', cleanup, { passive: true });
    slider.addEventListener('pointercancel', cleanup, { passive: true });
    slider.addEventListener('input', () => {
      if (slider.dataset.touchGuard === 'blocked') {
        slider.value = startValue;
      }
      updateColor();
    });
  }
}

function setPublishLockState({ locked, message }) {
  publishButton.disabled = Boolean(locked);
  donationGate.dataset.state = locked ? 'locked' : 'unlocked';
  donationGateText.textContent = message || '';
}

function createNoticeButton(info) {
  if (!info?.label) return null;
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `btn ${info.variant || 'btn-outline'}`.trim();
  element.textContent = info.label;
  element.addEventListener('click', info.onClick);
  return element;
}

function storageAvailabilityAction() {
  return {
    label: 'Storage Availability',
    variant: 'btn-outline',
    onClick: () => {
      window.location.href = '/users';
    }
  };
}

function showSiteNotice(message) {
  if (!message) {
    siteResult.style.display = 'none';
    siteResult.textContent = '';
    siteResult.innerHTML = '';
    siteResult.removeAttribute('data-state');
    return;
  }

  siteResult.innerHTML = '';
  siteResult.style.display = 'block';
  siteResult.dataset.state = message.state || 'notice';

  const textBlock = document.createElement('div');
  textBlock.className = 'notice-text';

  if (message.prefix) textBlock.appendChild(document.createTextNode(message.prefix));
  if (message.linkHref) {
    const anchor = document.createElement('a');
    anchor.href = message.linkHref;
    anchor.textContent = message.linkText || message.linkHref;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    textBlock.appendChild(anchor);
  } else if (message.text) {
    textBlock.appendChild(document.createTextNode(message.text));
  }
  if (message.suffix) textBlock.appendChild(document.createTextNode(message.suffix));
  siteResult.appendChild(textBlock);

  const buttons = Array.isArray(message.buttons) ? [...message.buttons] : [];
  if (isAuthenticatedSession(currentSession) && message.includeStorageAction !== false) {
    buttons.push(storageAvailabilityAction());
  }

  if (buttons.length) {
    const actions = document.createElement('div');
    actions.className = 'notice-actions';
    for (const buttonInfo of buttons) {
      const button = createNoticeButton(buttonInfo);
      if (button) actions.appendChild(button);
    }
    siteResult.appendChild(actions);
  }
}

async function downloadPhotos(site) {
  await downloadBlob(`/api/sites/${site.slug}/download`, `${site.slug}-originals.zip`);
}

async function downloadQr(site) {
  await downloadBlob(`/api/sites/${site.slug}/qr?download=1`, `${site.slug}-qr.png`);
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname === '[::1]';
}

function isLinkLocalHostname(hostname) {
  return /^169\.254\./.test(hostname)
    || /^fe80:/i.test(hostname)
    || /^\[fe80:/i.test(hostname);
}

function isLikelyShareableSiteUrl(siteUrl) {
  try {
    const parsed = new URL(siteUrl);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const hostname = String(parsed.hostname || '').trim().toLowerCase();
    if (!hostname) return false;
    return !isLoopbackHostname(hostname) && !isLinkLocalHostname(hostname);
  } catch {
    return false;
  }
}

function buildSiteNotice(site, { success = false } = {}) {
  const buttons = [
    {
      label: 'View Site',
      variant: 'btn-outline',
      onClick: () => {
        window.open(site.siteUrl, '_blank', 'noopener,noreferrer');
      }
    },
    {
      label: 'Download Photos',
      variant: 'btn-outline',
      onClick: async () => {
        try {
          await downloadPhotos(site);
        } catch (error) {
          alert(error.message || 'Could not download the photos.');
        }
      }
    }
  ];

  if (isLikelyShareableSiteUrl(site.siteUrl)) {
    buttons.push({
      label: 'Download QR Code',
      variant: 'btn-outline',
      onClick: async () => {
        try {
          await downloadQr(site);
        } catch (error) {
          alert(error.message || 'Could not download the QR code.');
        }
      }
    });
  }

  return {
    state: success ? 'success' : 'notice',
    prefix: success ? 'Your site is ready at ' : 'Editing site: ',
    linkHref: site.siteUrl,
    linkText: site.siteUrl,
    buttons
  };
}

function refreshDeleteSection({ resetInput = false } = {}) {
  if (!editingSite?.slug) {
    deleteSection.style.display = 'none';
    deleteConfirmPhrase = '';
    deletePhraseEl.textContent = '';
    if (resetInput) {
      deleteInput.value = '';
      deleteInput.placeholder = 'delete Site Title';
    }
    return;
  }

  deleteConfirmPhrase = `delete ${editingSite.title || editingSite.slug}`;
  deletePhraseEl.textContent = deleteConfirmPhrase;
  deleteSection.style.display = 'block';
  if (resetInput) {
    deleteInput.value = '';
  }
  deleteInput.placeholder = deleteConfirmPhrase;
}

function resetFormToDefaults() {
  formEl.reset();
  editingSite = null;
  siteFontSelect.value = DEFAULT_FONT_KEY;
  document.getElementById('hue').value = '96';
  document.getElementById('sat').value = '23.7';
  document.getElementById('light').value = '54';
  updateColor();
  refreshDeleteSection({ resetInput: true });
}

function applySiteToForm(site, { success = false } = {}) {
  if (!site) {
    resetFormToDefaults();
    showSiteNotice('');
    return;
  }

  const match = String(site.primaryColor || '').match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/i);
  if (match) {
    document.getElementById('hue').value = match[1];
    document.getElementById('sat').value = match[2];
    document.getElementById('light').value = match[3];
  }
  updateColor();

  siteTitleInput.value = site.title || '';
  siteFontSelect.value = resolveFontKey(site.fontFamily);
  editingSite = site;
  refreshDeleteSection({ resetInput: true });
  showSiteNotice(buildSiteNotice(site, { success }));
}

function setUserMenu() {
  userbar.style.display = 'flex';
  mainBtn.textContent = 'Go to main page';
  mainBtn.onclick = () => {
    window.location.href = '/';
  };

  if (isAuthenticatedSession(currentSession)) {
    avatarEl.src = avatarDataUri(currentSession.user.username);
    avatarEl.title = currentSession.user.username;
    authBtn.textContent = 'Sign out';
    authBtn.onclick = async () => {
      try {
        await logout();
        window.location.href = '/';
      } catch (error) {
        alert(error.message || 'Sign-out failed.');
      }
    };
  } else {
    avatarEl.src = avatarDataUri('?', { background: '#f3f4f6', color: '#6b7280' });
    avatarEl.title = 'Not signed in';
    authBtn.textContent = 'Sign in';
    authBtn.onclick = () => {
      window.location.href = '/';
    };
  }
}

async function loadEditableSite() {
  if (!isAuthenticatedSession(currentSession)) {
    editingSite = null;
    refreshDeleteSection({ resetInput: true });
    showSiteNotice('');
    return;
  }

  try {
    const endpoint = slugParam
      ? `/api/account/sites/current?slug=${encodeURIComponent(slugParam)}`
      : '/api/account/sites/current';
    const payload = await apiFetch(endpoint);
    if (payload.site) {
      applySiteToForm(payload.site);
      return;
    }
    resetFormToDefaults();
    showSiteNotice({
      text: 'Create your site below.'
    });
  } catch (error) {
    if (slugParam && error.status === 404) {
      resetFormToDefaults();
      showSiteNotice({
        text: `No site named "${slugParam}" was found. Complete the form below to create it.`
      });
      return;
    }
    throw error;
  }
}

async function refreshSession() {
  currentSession = await getSession();
  setUserMenu();
  if (isAuthenticatedSession(currentSession)) {
    setPublishLockState({ locked: false, message: '' });
  } else {
    setPublishLockState({
      locked: true,
      message: 'Sign in on the main page, or create an account there, to publish or edit your site.'
    });
  }
  await loadEditableSite();
}

async function submitForm(event) {
  event.preventDefault();
  const originalText = publishButton.textContent;
  publishButton.disabled = true;
  publishButton.textContent = editingSite ? 'Saving...' : 'Publishing...';

  try {
    if (!isAuthenticatedSession(currentSession)) {
      window.location.href = '/';
      return;
    }

    const payload = await apiFetch('/api/account/sites', {
      method: 'POST',
      body: JSON.stringify({
        title: siteTitleInput.value,
        primaryColor: hsl(),
        fontFamily: resolveFontKey(siteFontSelect.value),
        existingSlug: editingSite?.slug || ''
      })
    });

    applySiteToForm(payload.site, { success: true });
    const url = new URL(window.location.href);
    url.searchParams.set('slug', payload.site.slug);
    window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`);
    siteResult.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    alert(error.message || 'Could not save the site.');
  } finally {
    publishButton.disabled = !isAuthenticatedSession(currentSession);
    publishButton.textContent = originalText;
  }
}

async function handleDeleteSite() {
  if (!editingSite?.slug) {
    alert('No site is currently loaded to delete.');
    return;
  }

  const typed = String(deleteInput.value || '').trim();
  if (typed !== deleteConfirmPhrase) {
    alert(`Type "${deleteConfirmPhrase}" exactly to confirm deletion.`);
    return;
  }
  if (!window.confirm('This will permanently delete your site and all associated files. Continue?')) {
    return;
  }

  deleteButton.disabled = true;
  deleteButton.textContent = 'Deleting...';

  try {
    await apiFetch(`/api/account/sites/${encodeURIComponent(editingSite.slug)}`, {
      method: 'DELETE'
    });
    resetFormToDefaults();
    showSiteNotice({
      state: 'success',
      text: 'Site deleted successfully.'
    });
    const url = new URL(window.location.href);
    url.searchParams.delete('slug');
    window.history.replaceState({}, '', url.pathname);
  } catch (error) {
    alert(error.message || 'Could not delete the site.');
  } finally {
    deleteButton.disabled = false;
    deleteButton.textContent = 'Delete site permanently';
  }
}

function initUserMenu() {
  avatarEl.addEventListener('click', (event) => {
    event.stopPropagation();
    menuEl.classList.toggle('show');
  });
  document.addEventListener('click', () => {
    menuEl.classList.remove('show');
  });
}

function initFormEvents() {
  formEl.addEventListener('submit', submitForm);
  deleteButton.addEventListener('click', handleDeleteSite);
  siteTitleInput.addEventListener('input', () => refreshDeleteSection());
}

installRangeGuards();
updateColor();
initUserMenu();
initFormEvents();

refreshSession().catch((error) => {
  console.error(error);
  alert(error.message || 'Could not load the editor.');
});
