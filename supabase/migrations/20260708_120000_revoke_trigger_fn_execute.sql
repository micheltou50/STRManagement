-- Security hardening (2026-07-08). The security advisor flagged three
-- SECURITY DEFINER functions as callable via /rest/v1/rpc by the anon and
-- authenticated roles:
--   expenses_soft_delete(), platform_payouts_soft_delete(), link_cleaner_on_signup()
-- All three are TRIGGER functions (return `trigger`, each used by exactly one
-- trigger) and NOTHING calls them via .rpc() anywhere in the app or Netlify
-- functions. Left exposed, an unauthenticated request could invoke the soft-delete
-- functions to tamper with expense / payout records. Revoking EXECUTE closes the
-- API exposure; the triggers still fire on their DML events, so app behaviour is
-- unchanged. Applied to prod (project nbeuyypgiipptxlqnhel) via Supabase MCP.
revoke execute on function public.expenses_soft_delete() from public, anon, authenticated;
revoke execute on function public.platform_payouts_soft_delete() from public, anon, authenticated;
revoke execute on function public.link_cleaner_on_signup() from public, anon, authenticated;
