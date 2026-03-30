import { getSession, isAuthenticatedSession, login, logout, register } from '/js/api.js?v=20260330-2';

const authForm = document.getElementById('authForm');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const confirmPasswordField = document.getElementById('confirmPasswordField');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');
const togglePasswordButton = document.getElementById('togglePasswordButton');
const toggleConfirmPasswordButton = document.getElementById('toggleConfirmPasswordButton');
const signInButton = document.getElementById('signInButton');
const createAccountButton = document.getElementById('createAccountButton');
const signedOutActions = document.getElementById('signedOutActions');
const accountPanel = document.getElementById('accountPanel');
const accountStatus = document.getElementById('accountStatus');
const openEditorButton = document.getElementById('openEditorButton');
const signOutButton = document.getElementById('signOutButton');
const authMessage = document.getElementById('authMessage');

const AUTH_MODE_LOGIN = 'login';
const AUTH_MODE_REGISTER = 'register';

let authMode = AUTH_MODE_LOGIN;
let passwordsVisible = false;

const EYE_OPEN_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>
`;

const EYE_CLOSED_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 3l18 18"></path>
    <path d="M10.6 10.7a3 3 0 0 0 4.2 4.2"></path>
    <path d="M9.9 5.2A11.6 11.6 0 0 1 12 5c6.4 0 10 7 10 7a18.7 18.7 0 0 1-4.1 4.9"></path>
    <path d="M6.2 6.3A18.2 18.2 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4-.8"></path>
  </svg>
`;

function setBusyState(busy) {
  usernameInput.disabled = busy;
  passwordInput.disabled = busy;
  confirmPasswordInput.disabled = busy || authMode !== AUTH_MODE_REGISTER;
  togglePasswordButton.disabled = busy;
  toggleConfirmPasswordButton.disabled = busy || authMode !== AUTH_MODE_REGISTER;
  signInButton.disabled = busy;
  createAccountButton.disabled = busy;
}

function setAuthMessage(message) {
  authMessage.textContent = message || '';
}

function setPasswordVisibility(visible) {
  passwordsVisible = Boolean(visible);
  const inputType = passwordsVisible ? 'text' : 'password';
  passwordInput.type = inputType;
  confirmPasswordInput.type = inputType;
  syncPasswordToggle(togglePasswordButton, {
    visible: passwordsVisible,
    label: 'password'
  });
  syncPasswordToggle(toggleConfirmPasswordButton, {
    visible: passwordsVisible,
    label: 'retyped password'
  });
}

function syncPasswordToggle(button, { visible, label }) {
  const actionLabel = visible ? 'Hide' : 'Show';
  button.innerHTML = visible ? EYE_CLOSED_ICON : EYE_OPEN_ICON;
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', `${actionLabel} ${label}`);
  button.setAttribute('title', `${actionLabel} ${label}`);
}

function setAuthMode(mode) {
  authMode = mode === AUTH_MODE_REGISTER ? AUTH_MODE_REGISTER : AUTH_MODE_LOGIN;
  const creatingAccount = authMode === AUTH_MODE_REGISTER;
  confirmPasswordField.hidden = !creatingAccount;
  confirmPasswordInput.required = creatingAccount;
  passwordInput.autocomplete = creatingAccount ? 'new-password' : 'current-password';
  signInButton.textContent = creatingAccount ? 'Create Account' : 'Sign In';
  createAccountButton.textContent = creatingAccount ? 'Back to Sign In' : 'Create Account';
  setAuthMessage('');
}

function clearSensitiveInputs() {
  passwordInput.value = '';
  confirmPasswordInput.value = '';
  setPasswordVisibility(false);
}

function setSignedInState(session) {
  const signedIn = isAuthenticatedSession(session);
  authForm.style.display = signedIn ? 'none' : 'grid';
  signedOutActions.style.display = signedIn ? 'none' : 'grid';
  accountPanel.classList.toggle('show', signedIn);
  if (signedIn) {
    accountStatus.textContent = `Signed in as ${session.user.username}`;
    setAuthMessage('');
    return;
  }

  setAuthMode(authMode);
}

async function refreshSession() {
  const session = await getSession();
  setSignedInState(session);
  return session;
}

function readCredentials() {
  return {
    username: usernameInput.value.trim(),
    password: passwordInput.value,
    confirmPassword: confirmPasswordInput.value
  };
}

async function handleAuth() {
  setAuthMessage('');
  if (!authForm.reportValidity()) {
    return;
  }
  setBusyState(true);

  try {
    const credentials = readCredentials();
    if (authMode === AUTH_MODE_REGISTER) {
      if (credentials.password !== credentials.confirmPassword) {
        throw new Error('Passwords do not match.');
      }
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
  await handleAuth();
});

createAccountButton.addEventListener('click', () => {
  const nextMode = authMode === AUTH_MODE_REGISTER
    ? AUTH_MODE_LOGIN
    : AUTH_MODE_REGISTER;
  setAuthMode(nextMode);
  clearSensitiveInputs();
  if (nextMode === AUTH_MODE_REGISTER) {
    passwordInput.focus();
  } else {
    usernameInput.focus();
  }
});

togglePasswordButton.addEventListener('click', (event) => {
  event.preventDefault();
  setPasswordVisibility(!passwordsVisible);
});

toggleConfirmPasswordButton.addEventListener('click', (event) => {
  event.preventDefault();
  setPasswordVisibility(!passwordsVisible);
});

openEditorButton.addEventListener('click', () => {
  window.location.href = '/form';
});

signOutButton.addEventListener('click', async () => {
  try {
    await logout();
    clearSensitiveInputs();
    setAuthMode(AUTH_MODE_LOGIN);
    setAuthMessage('');
    await refreshSession();
  } catch (error) {
    setAuthMessage(error.message || 'Sign-out failed.');
  }
});

setAuthMode(AUTH_MODE_LOGIN);
setPasswordVisibility(false);

refreshSession().catch(() => {
  setSignedInState({ isAuthenticated: false, user: null });
});
