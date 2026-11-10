-- Cleaner phase 2b (2026-10-11): per-clean checklist progress + photo proof.
-- Idempotent — safe to re-run.
--
-- 1. cleans.checklist_done — the checklist items (host-defined per property in
--    properties.check_in_info.checklist, one string per item) the cleaner has
--    ticked on THIS clean. Array of the item strings. Written by the cleaner PWA
--    (assets/js/render-cleaner.js cleanerToggleCheck) through the existing
--    cleaner_update_own_cleans RLS policy; the host only resets it to [] when
--    the clean is unassigned/reassigned (assets/js/supabase-cleans.js).
-- 2. cleans.photos — photo proof taken on finish: [{url, path, at}]. Uploaded by
--    the cleaner PWA straight to the public `photos` bucket under
--    cleans/<cleaner uuid>/<clean id>/… (assets/js/render-cleaner.js
--    cleanerAddPhoto), downscaled client-side. Never written from the host side.
-- 3. Storage policy letting a signed-in cleaner INSERT into their own folder of
--    the photos bucket. NOTE: the bucket already carries a pre-existing
--    "Service key upload" INSERT policy whose check is just bucket_id='photos'
--    (i.e. any client may upload). The service key bypasses RLS and never needed
--    it; tightening that is a separate, cross-app (Glenhaven) change and is left
--    alone here — this policy documents the intended scope and survives it.

alter table public.cleans add column if not exists checklist_done jsonb not null default '[]'::jsonb;
alter table public.cleans add column if not exists photos         jsonb not null default '[]'::jsonb;

comment on column public.cleans.checklist_done is
  'Checklist items (strings from properties.check_in_info.checklist) the cleaner has ticked on this clean.';
comment on column public.cleans.photos is
  'Photo proof from the cleaner: [{url, path, at}] — objects in the photos bucket under cleans/<cleaner uuid>/<clean id>/.';

drop policy if exists "Cleaners upload clean photos" on storage.objects;
create policy "Cleaners upload clean photos"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = 'cleans'
    and (storage.foldername(name))[2] in (
      select id::text from public.cleaners where auth_user_id = auth.uid()
    )
  );
