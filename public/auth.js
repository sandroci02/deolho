async function getCurrentUser() {
  const response = await fetch('/api/auth/me');
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return data.user || null;
}

async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }
  return user;
}

async function logoutAndRedirect() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
  window.location.href = '/login.html';
}
