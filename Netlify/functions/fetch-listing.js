// Fetches an Airbnb listing page, extracts property details, and returns them
// for auto-filling the property setup form.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(statusCode, data) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

// Map Airbnb @type / description strings to our app property types
function mapPropertyType(raw) {
  if (!raw) return 'house';
  const lower = String(raw).toLowerCase();
  if (lower.includes('apartment') || lower.includes('entire home/apt')) return 'apartment';
  if (lower.includes('villa')) return 'villa';
  if (lower.includes('cabin')) return 'cabin';
  if (lower.includes('house') || lower.includes('home')) return 'house';
  return 'house';
}

// ── Tier 1: JSON-LD ────────────────────────────────────────────────────────
function extractJsonLd(html) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) return null;

  try {
    const ld = JSON.parse(match[1]);
    return {
      title: ld.name || null,
      description: ld.description || null,
      bedrooms: ld.numberOfBedrooms != null ? Number(ld.numberOfBedrooms) : null,
      bathrooms: ld.numberOfBathroomsTotal != null ? Number(ld.numberOfBathroomsTotal) : null,
      maxGuests: ld.occupancy && ld.occupancy.maxValue != null ? Number(ld.occupancy.maxValue) : null,
      propertyType: ld['@type'] || null,
      image: ld.image || null,
    };
  } catch (e) {
    console.error('[StayOps] fetch-listing: JSON-LD parse error', e.message);
    return null;
  }
}

// ── Tier 2: OpenGraph + <title> ────────────────────────────────────────────
function extractOpenGraph(html) {
  const ogTitle = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || [])[1] || null;
  const ogDesc = (html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/) || [])[1] || null;
  const ogImage = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/) || [])[1] || null;
  const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/) || [])[1] || null;

  return {
    title: ogTitle || titleTag || null,
    description: ogDesc || null,
    image: ogImage || null,
  };
}

// ── Tier 3: Claude Haiku fallback ──────────────────────────────────────────
async function extractWithClaude(html) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  // Strip scripts, styles, and HTML tags; take first 5000 chars
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);

  if (!stripped) return null;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content:
              'Extract property details from this Airbnb listing page text. ' +
              'Return JSON with: title, propertyType (house/apartment/villa/cabin/other), ' +
              'bedrooms (number), bathrooms (number), maxGuests (number). ' +
              'Return ONLY valid JSON, nothing else.\n\n' +
              stripped,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error('[StayOps] fetch-listing: Claude API returned', response.status);
      return null;
    }

    const data = await response.json();
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) return null;

    // Parse the JSON from Claude's response (may be wrapped in markdown fences)
    const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[StayOps] fetch-listing: Claude extraction failed', e.message);
    return null;
  }
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[StayOps] fetch-listing: invalid JSON body', e.message);
    return respond(400, { error: 'Invalid JSON' });
  }

  const url = (body.url || '').trim();

  // Extract listing ID
  const idMatch = url.match(/airbnb\.[a-z.]+\/rooms\/(\d+)/i);
  if (!idMatch) {
    return respond(400, { error: 'Not a valid Airbnb listing URL' });
  }

  const listingId = idMatch[1];
  const raw_url = url;

  // Fetch the Airbnb page
  let html;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error('[StayOps] fetch-listing: Airbnb returned', response.status);
      return respond(200, {
        error: 'Could not fetch listing (HTTP ' + response.status + ')',
        listingId,
        raw_url,
      });
    }

    html = await response.text();
  } catch (e) {
    console.error('[StayOps] fetch-listing: fetch error', e.message);
    return respond(200, {
      error: e.name === 'TimeoutError' ? 'Request timed out' : 'Could not fetch listing',
      listingId,
      raw_url,
    });
  }

  // ── Tier 1: JSON-LD ──────────────────────────────────────────────────
  const tier1 = extractJsonLd(html);

  // ── Tier 2: OpenGraph ─────────────────────────────────────────────────
  const tier2 = extractOpenGraph(html);

  // ── Tier 3: Claude Haiku (only if tier 1+2 gave no title) ─────────────
  let tier3 = null;
  const hasTitle = (tier1 && tier1.title) || (tier2 && tier2.title);
  if (!hasTitle) {
    tier3 = await extractWithClaude(html);
  }

  // ── Merge results (tier 1 > tier 2 > tier 3) ─────────────────────────
  const merged = {
    listingId,
    title: (tier1 && tier1.title) || (tier2 && tier2.title) || (tier3 && tier3.title) || null,
    description:
      (tier1 && tier1.description) || (tier2 && tier2.description) || (tier3 && tier3.description) || null,
    propertyType: mapPropertyType(
      (tier1 && tier1.propertyType) || (tier3 && tier3.propertyType) || null
    ),
    bedrooms: (tier1 && tier1.bedrooms) || (tier3 && tier3.bedrooms) || null,
    bathrooms: (tier1 && tier1.bathrooms) || (tier3 && tier3.bathrooms) || null,
    maxGuests: (tier1 && tier1.maxGuests) || (tier3 && tier3.maxGuests) || null,
    image: (tier1 && tier1.image) || (tier2 && tier2.image) || null,
    raw_url,
  };

  // Flag partial result if we couldn't get a title at all
  if (!merged.title) {
    merged.partial = true;
  }

  return respond(200, merged);
};
