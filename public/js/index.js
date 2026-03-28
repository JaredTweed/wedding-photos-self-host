import { getSession, isAuthenticatedSession, login, logout, register } from '/js/api.js';

const authForm = document.getElementById('authForm');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const signInButton = document.getElementById('signInButton');
const createAccountButton = document.getElementById('createAccountButton');
const signedOutActions = document.getElementById('signedOutActions');
const accountPanel = document.getElementById('accountPanel');
const accountStatus = document.getElementById('accountStatus');
const openEditorButton = document.getElementById('openEditorButton');
const signOutButton = document.getElementById('signOutButton');
const authMessage = document.getElementById('authMessage');

function setBusyState(busy) {
  usernameInput.disabled = busy;
  passwordInput.disabled = busy;
  signInButton.disabled = busy;
  createAccountButton.disabled = busy;
}

function setAuthMessage(message) {
  authMessage.textContent = message || '';
}

function setSignedInState(session) {
  const signedIn = isAuthenticatedSession(session);
  authForm.style.display = signedIn ? 'none' : 'grid';
  signedOutActions.style.display = signedIn ? 'none' : 'grid';
  accountPanel.classList.toggle('show', signedIn);
  if (signedIn) {
    accountStatus.textContent = `Signed in as ${session.user.username}`;
    setAuthMessage('');
  }
}

async function refreshSession() {
  const session = await getSession();
  setSignedInState(session);
  return session;
}

function readCredentials() {
  return {
    username: usernameInput.value.trim(),
    password: passwordInput.value
  };
}

async function handleAuth(action) {
  setBusyState(true);
  setAuthMessage('');

  try {
    const credentials = readCredentials();
    if (action === 'register') {
      await register(credentials);
    } else {
      await login(credentials);
    }
    window.location.href = '/form';
  } catch (error) {
    setAuthMessage(error.message || 'Authentication failed.');
  } finally {
    setBusyState(false);
  }
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await handleAuth('login');
});

createAccountButton.addEventListener('click', async () => {
  await handleAuth('register');
});

openEditorButton.addEventListener('click', () => {
  window.location.href = '/form';
});

signOutButton.addEventListener('click', async () => {
  try {
    await logout();
    passwordInput.value = '';
    setAuthMessage('');
    await refreshSession();
  } catch (error) {
    setAuthMessage(error.message || 'Sign-out failed.');
  }
});

refreshSession().catch(() => {
  setSignedInState({ isAuthenticated: false, user: null });
});
