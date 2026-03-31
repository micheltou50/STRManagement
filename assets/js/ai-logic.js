// ES module.
// window.AIService is preserved so main.js (classic script) can call it unchanged.
const AI_ENDPOINT = '/.netlify/functions/ai-proxy';

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
