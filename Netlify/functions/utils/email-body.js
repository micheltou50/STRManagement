/**
 * StayOps — email body extraction shared by the on-open Gmail/Outlook scans and
 * the hourly scheduled review scan. Moved here verbatim from the two scanners
 * so every reader of a mailbox sees exactly the same text.
 */

function getHeader(headers, name) {
  if (!headers) return '';
  const h = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodeBase64(data) {
  const safe = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(safe, 'base64').toString('utf-8');
}

function extractGmailBody(msg) {
  const parts = msg.payload.parts || [];
  let plain = '';
  let html = '';

  function walk(part) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      plain += decodeBase64(part.body.data) + '\n';
    }
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      html += decodeBase64(part.body.data) + '\n';
    }
    if (part.parts) part.parts.forEach(walk);
  }

  if (msg.payload.body && msg.payload.body.data) {
    if (msg.payload.mimeType === 'text/plain') {
      plain = decodeBase64(msg.payload.body.data);
    } else {
      html = decodeBase64(msg.payload.body.data);
    }
  }
  parts.forEach(walk);

  if (plain.trim()) return plain.trim().slice(0, 8000);

  if (html.trim()) {
    const stripped = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.slice(0, 8000);
  }

  return '';
}

function extractOutlookBody(msg) {
  if (!msg.body || !msg.body.content) return '';
  const { contentType, content } = msg.body;

  if (contentType === 'text') {
    return content.trim().slice(0, 8000);
  }

  const stripped = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped.slice(0, 8000);
}

module.exports = { getHeader, decodeBase64, extractGmailBody, extractOutlookBody };
