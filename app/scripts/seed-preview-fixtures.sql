INSERT OR IGNORE INTO filers
  (bioguide_id, chamber, full_name, party, state, district, committees, photo_url)
VALUES
  ('P000197', 'house', 'Nancy Pelosi', 'Democrat', 'CA', '11', '[]', 'https://unitedstates.github.io/images/congress/225x275/P000197.jpg'),
  ('P000449', 'senate', 'David A Perdue, Jr', 'Republican', 'GA', NULL, '[]', 'https://unitedstates.github.io/images/congress/225x275/P000449.jpg'),
  ('S001217', 'senate', 'Rick Scott', 'Republican', 'FL', NULL, '[]', 'https://unitedstates.github.io/images/congress/225x275/S001217.jpg');

INSERT OR IGNORE INTO filings
  (doc_id, chamber, filer_id, filing_type, filed_date, source_url, ingest_status, doc_kind, extractor, model_version, confidence, first_seen_at, source_updated_at, error)
VALUES
  ('PREVIEW-H-20034836', 'house', 'P000197', 'P', '2026-06-23', 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034836.pdf', 'complete', 'pdf', 'house_pdf', 'preview-fixture', 0.99, '2026-06-24T13:03:00Z', '2026-06-24T13:03:00Z', NULL),
  ('PREVIEW-S-PERDUE', 'senate', 'P000449', 'P', '2026-06-21', '', 'complete', 'html', 'seed_fixture', 'preview-fixture', 1.0, '2026-06-21T08:00:00Z', '2026-06-21T08:00:00Z', NULL),
  ('PREVIEW-S-SCOTT', 'senate', 'S001217', 'P', NULL, '', 'complete', 'html', 'seed_fixture', 'preview-fixture', 0.95, '2026-06-21T15:33:00Z', '2026-06-21T15:33:00Z', NULL);

INSERT INTO transactions
  (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type, tx_type, amount_min, amount_max, is_option, cap_gains_over_200, raw_text, confidence, source, created_at, cursor_seq, est_value)
VALUES
  ('preview-pelosi-intc', 'PREVIEW-H-20034836', 'P000197', '2026-05-29', 'spouse', 'Intel Corporation - Common Stock (INTC) [OP]', 'INTC', 'OP', 'P', 1000001, 5000000, 1, 0, 'Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27.', 0.99, 'primary', '2026-06-24T13:05:00Z', 900001, 3000000.5),
  ('preview-pelosi-uber', 'PREVIEW-H-20034836', 'P000197', '2026-05-29', 'spouse', 'Uber Technologies, Inc. Common Stock (UBER) [OP]', 'UBER', 'OP', 'P', 500001, 1000000, 1, 0, 'Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27.', 0.99, 'primary', '2026-06-24T13:06:00Z', 900002, 750000.5),
  ('preview-perdue-axta', 'PREVIEW-S-PERDUE', 'P000449', '2026-06-20', 'self', 'Axalta Coating Systems Ltd.', 'AXTA', 'ST', 'P', 1001, 15000, 0, 0, '', 1.0, 'primary', '2026-06-21T08:02:00Z', 900003, 8000.5),
  ('preview-scott-bond', 'PREVIEW-S-SCOTT', 'S001217', '2019-10-16', 'self', 'Obligation Bond Rate/Coupon: 4.0% Matures: 07/01/2038', NULL, 'BO', 'P', 100001, 250000, 0, 0, '', 0.95, 'seed_dataset', '2026-06-21T15:35:00Z', 900004, 175000.5)
ON CONFLICT(id) DO UPDATE SET est_value = excluded.est_value;
