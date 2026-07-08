-- Storage hardening (2026-07-08). The public `photos` bucket (Glenhaven property
-- photos) had two overly-broad policies on storage.objects:
--   1. "Public read access" (SELECT, role public) — let ANY client LIST every file
--      in the bucket. Public buckets serve /object/public/ URLs WITHOUT a SELECT
--      policy, and nothing in Glenhaven or StayOps calls storage .list()/.download()
--      on photos (verified: uploads are server-signed via the service key in
--      glenhaven-book/netlify/functions/upload.js; display uses public object URLs).
--   2. "Service key delete" (DELETE, role public) — despite its name it granted
--      DELETE to ANY client (verified: anon key could delete before, 403 after).
--      The service key bypasses RLS entirely, so server-side deletes never needed it.
-- Verified after applying: anon list returns [], anon delete returns 403, and
-- public object URLs still serve 200. Applied to prod via Supabase MCP.
drop policy if exists "Public read access" on storage.objects;
drop policy if exists "Service key delete" on storage.objects;
