import { ensureAdminSession, getSession } from '/js/api.js';

const createButton = document.getElementById('createSiteButton');

window.signInWithPassword = async function signInWithPassword() {
  try {
    const signedIn = await ensureAdminSession();
    if (!signedIn) return;
    window.location.href = '/form';
  } catch (error) {
    alert(error.message || 'Sign-in failed.');
  }
};

async function init() {
  try {
    const session = await getSession();
    if (session.isAdmin && createButton) {
      createButton.textContent = 'Open Site Editor';
    }
  } catch {
    // Keep the default button state when the session check fails.
  }
}

init();
