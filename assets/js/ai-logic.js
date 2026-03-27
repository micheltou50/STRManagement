// ES module.
// window.AIService is preserved so main.js (classic script) can call it unchanged.
const AI_ENDPOINT = '/.netlify/functions/ai';

async function request(payload) {
  const response = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let data = {};
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

// Backward compat: main.js is a classic script and reads AIService from window.
// This assignment is safe to remove only after main.js is also converted to a module.
window.AIService = AIService;
