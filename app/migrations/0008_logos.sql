-- 0008_logos.sql
-- Company logo URL for the feed (the "ticker logos + company names" work).
-- Populated by the enrichment chain (Finnhub CDN preferred for direct display,
-- Massive/Polygon branding as fallback). Nullable; degrades to no logo.

ALTER TABLE securities_ref ADD COLUMN logo_url TEXT;
