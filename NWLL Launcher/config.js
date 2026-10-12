/* Public OAuth client settings only. Keep provider client secrets in .env on the server. */
window.ORBIT_CONFIG = {
  google: { clientId: "228889399204-6ie8re6f9ra43m6bssfr6vve4lffm42m.apps.googleusercontent.com", redirectUri: `${location.origin}/auth/callback/google` },
};
