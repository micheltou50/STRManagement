// ES module.
// window.AIService is preserved so main.js (classic script) can call it unchanged.
const AI_ENDPOINT = '/.netlify/functions/ai-proxy';

async function request(payload) {
  // ai-proxy now requires a Supabase JWT. getAuthHeaders() (exposed on
  // globalThis by supabase.js) returns the Authorization header when signed in.
  let headers = { 'Content-Type': 'application/json' };
  try {
    if (typeof globalThis.getAuthHeaders === 'function') {
      headers = await globalThis.getAuthHeaders();
    }
  } catch (_) { /* fall back to unauthenticated; proxy will 401 */ }

  const response = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  let data;
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }

  return { response, data };
}

export const AIService = {
  request,
  endpoint: AI_ENDPOINT
};
