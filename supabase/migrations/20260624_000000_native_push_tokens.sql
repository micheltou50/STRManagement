-- StayOps — native iOS (APNs) push support.
-- Stores per-device APNs tokens for the Capacitor app so the backend
-- (send-push.js / utils/push-helper.js) can deliver host notifications via APNs.
-- Idempotent; applied to prod via Supabase MCP on 2026-06-24.
--
-- Shape: jsonb array of { token: string, platform: 'ios', updated_at: iso8601 }.
ALTER TABLE app_config
  ADD COLUMN IF NOT EXISTS native_push_tokens jsonb DEFAULT '[]'::jsonb;
