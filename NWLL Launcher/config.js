/* OAuth settings: fill these values after creating provider apps.
   Google: https://console.cloud.google.com/apis/credentials
   Apple: https://developer.apple.com/account/resources/identifiers/list/serviceId
   Set redirectUri to an HTTPS callback endpoint that validates state and exchanges
   the authorization code server-side. Do not put client secrets in this file. */
window.ORBIT_CONFIG = {
  google: { clientId: "", redirectUri: `${location.origin}/auth/callback/google` },
  apple: { clientId: "", redirectUri: `${location.origin}/auth/callback/apple` },
};
