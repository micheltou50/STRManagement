(function () {
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

  window.AIService = {
    request,
    endpoint: AI_ENDPOINT
  };
})();
