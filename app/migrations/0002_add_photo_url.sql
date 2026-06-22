-- Member headshot URL, populated by POST /api/admin/enrich-photos (resolves
-- each filer's name -> bioguide via the congress-legislators dataset, then
-- points at the public unitedstates/images CDN). NULL = no photo (UI shows
-- initials).
ALTER TABLE filers ADD COLUMN photo_url TEXT;
