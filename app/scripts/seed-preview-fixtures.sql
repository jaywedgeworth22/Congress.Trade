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

-- Deterministic, non-billable benchmark history for rendered preview QA. These
-- synthetic rows exercise all three chamber tabs, partial and complete cost
-- coverage, speed percentiles, tier-1 agreement, and resolver escalation.
INSERT OR REPLACE INTO benchmark_runs
  (id, chamber, status, requested_doc_count, completed_doc_count, model_count,
   models_json, request_profile_json, started_at, completed_at, duration_ms,
   known_cost_usd, cost_covered_calls, invoked_calls, summary_json,
   selected_lineup_json, selected_at, selection_error, selection_audit_json,
   error, created_at, updated_at)
VALUES
  ('PREVIEW-BENCH-HOUSE', 'house', 'completed', 1, 1, 3,
   '[{"provider":"openai","model":"gpt-5.6-terra"},{"provider":"mistral","model":"mistral-ocr-latest"},{"provider":"anthropic","model":"claude-haiku-4-5"}]',
   '{"fixture":true,"billing":"synthetic-preview-only"}',
   '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:04.000Z', 4000,
   0.015, 2, 3, NULL, NULL, NULL, NULL, NULL, NULL,
   '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:04.000Z'),
  ('PREVIEW-BENCH-SENATE', 'senate', 'completed', 1, 1, 3,
   '[{"provider":"openai","model":"gpt-5.6-terra"},{"provider":"mistral","model":"mistral-ocr-latest"},{"provider":"anthropic","model":"claude-haiku-4-5"}]',
   '{"fixture":true,"billing":"synthetic-preview-only"}',
   '2026-07-13T12:10:00.000Z', '2026-07-13T12:10:05.000Z', 5000,
   0.016, 3, 3, NULL, NULL, NULL, NULL, NULL, NULL,
   '2026-07-13T12:10:00.000Z', '2026-07-13T12:10:05.000Z'),
  ('PREVIEW-BENCH-EXEC', 'executive', 'completed', 1, 1, 3,
   '[{"provider":"openai","model":"gpt-5.6-terra"},{"provider":"mistral","model":"mistral-ocr-latest"},{"provider":"anthropic","model":"claude-haiku-4-5"}]',
   '{"fixture":true,"billing":"synthetic-preview-only"}',
   '2026-07-13T12:20:00.000Z', '2026-07-13T12:20:06.000Z', 6000,
   0.022, 3, 3, NULL, NULL, NULL, NULL, NULL, NULL,
   '2026-07-13T12:20:00.000Z', '2026-07-13T12:20:06.000Z');

INSERT OR REPLACE INTO benchmark_run_documents
  (run_id, doc_id, ordinal, resolved, ground_truth_json)
VALUES
  ('PREVIEW-BENCH-HOUSE', 'PREVIEW-BENCH-DOC-HOUSE', 0, 1,
   '[{"ticker":"AAPL","assetName":"Apple Inc.","txDate":"2026-06-01","txType":"P","amountMin":1001,"amountMax":15000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.96}]'),
  ('PREVIEW-BENCH-SENATE', 'PREVIEW-BENCH-DOC-SENATE', 0, 1,
   '[{"ticker":"MSFT","assetName":"Microsoft Corp.","txDate":"2026-06-02","txType":"P","amountMin":15001,"amountMax":50000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.95}]'),
  ('PREVIEW-BENCH-EXEC', 'PREVIEW-BENCH-DOC-EXEC', 0, 1,
   '[{"ticker":"NVDA","assetName":"NVIDIA Corp.","txDate":"2026-06-03","txType":"S","amountMin":50001,"amountMax":100000,"owner":"self","assetType":"Stock","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":"New","subholding":null,"location":null,"description":null,"supplementalText":"Notification date 2026-06-05","confidence":0.94}]');

INSERT OR REPLACE INTO benchmark_model_results
  (run_id, doc_id, provider, model, resolved_model, invoked, ok, outcome,
   autonomous, error, row_count, avg_confidence, latency_ms, cost_usd,
   cost_source, cost_detail_json, provider_request_id, usage_json, result_json,
   perfect_match, true_positive, false_positive, false_negative, started_at,
   completed_at, claim_token, lease_until, created_at)
VALUES
  ('PREVIEW-BENCH-HOUSE', 'PREVIEW-BENCH-DOC-HOUSE', 'openai', 'gpt-5.6-terra', 'gpt-5.6-terra-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.96, 1800, 0.012, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"promptTokens":1500,"completionTokens":250}', '{"rows":[{"ticker":"AAPL","assetName":"Apple Inc.","txDate":"2026-06-01","txType":"P","amountMin":1001,"amountMax":15000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.96}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:01.800Z', NULL, NULL, '2026-07-13T12:00:01.800Z'),
  ('PREVIEW-BENCH-HOUSE', 'PREVIEW-BENCH-DOC-HOUSE', 'mistral', 'mistral-ocr-latest', 'mistral-ocr-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.95, 900, 0.003, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"pagesProcessed":3}', '{"rows":[{"ticker":"AAPL","assetName":"Apple Inc.","txDate":"2026-06-01","txType":"P","amountMin":1001,"amountMax":15000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.95}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:00:01.800Z', '2026-07-13T12:00:02.700Z', NULL, NULL, '2026-07-13T12:00:02.700Z'),
  ('PREVIEW-BENCH-HOUSE', 'PREVIEW-BENCH-DOC-HOUSE', 'anthropic', 'claude-haiku-4-5', 'claude-haiku-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.94, 1100, NULL, 'unknown', '{"reason":"synthetic_unknown_cost"}', NULL, '{"promptTokens":1400,"completionTokens":220}', '{"rows":[{"ticker":"AAPL","assetName":"Apple Inc.","txDate":"2026-06-01","txType":"P","amountMin":1001,"amountMax":15000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.94}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:00:02.700Z', '2026-07-13T12:00:03.800Z', NULL, NULL, '2026-07-13T12:00:03.800Z'),

  ('PREVIEW-BENCH-SENATE', 'PREVIEW-BENCH-DOC-SENATE', 'openai', 'gpt-5.6-terra', 'gpt-5.6-terra-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.95, 2100, 0.010, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"promptTokens":1300,"completionTokens":210}', '{"rows":[{"ticker":"MSFT","assetName":"Microsoft Corp.","txDate":"2026-06-02","txType":"P","amountMin":15001,"amountMax":50000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.95}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:10:00.000Z', '2026-07-13T12:10:02.100Z', NULL, NULL, '2026-07-13T12:10:02.100Z'),
  ('PREVIEW-BENCH-SENATE', 'PREVIEW-BENCH-DOC-SENATE', 'mistral', 'mistral-ocr-latest', 'mistral-ocr-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.90, 700, 0.002, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"pagesProcessed":2}', '{"rows":[{"ticker":"TSLA","assetName":"Tesla Inc.","txDate":"2026-06-02","txType":"S","amountMin":15001,"amountMax":50000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture disagreement","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.90}],"flags":[]}', 0, 0, 1, 1, '2026-07-13T12:10:02.100Z', '2026-07-13T12:10:02.800Z', NULL, NULL, '2026-07-13T12:10:02.800Z'),
  ('PREVIEW-BENCH-SENATE', 'PREVIEW-BENCH-DOC-SENATE', 'anthropic', 'claude-haiku-4-5', 'claude-haiku-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.94, 1500, 0.004, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"promptTokens":1200,"completionTokens":200}', '{"rows":[{"ticker":"MSFT","assetName":"Microsoft Corp.","txDate":"2026-06-02","txType":"P","amountMin":15001,"amountMax":50000,"owner":"self","assetType":"ST","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":null,"subholding":null,"location":null,"description":null,"supplementalText":null,"confidence":0.94}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:10:02.800Z', '2026-07-13T12:10:04.300Z', NULL, NULL, '2026-07-13T12:10:04.300Z'),

  ('PREVIEW-BENCH-EXEC', 'PREVIEW-BENCH-DOC-EXEC', 'openai', 'gpt-5.6-terra', 'gpt-5.6-terra-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.94, 2500, 0.014, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"promptTokens":1800,"completionTokens":300}', '{"rows":[{"ticker":"NVDA","assetName":"NVIDIA Corp.","txDate":"2026-06-03","txType":"S","amountMin":50001,"amountMax":100000,"owner":"self","assetType":"Stock","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":"New","subholding":null,"location":null,"description":null,"supplementalText":"Notification date 2026-06-05","confidence":0.94}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:20:00.000Z', '2026-07-13T12:20:02.500Z', NULL, NULL, '2026-07-13T12:20:02.500Z'),
  ('PREVIEW-BENCH-EXEC', 'PREVIEW-BENCH-DOC-EXEC', 'mistral', 'mistral-ocr-latest', 'mistral-ocr-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.93, 1000, 0.003, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"pagesProcessed":3}', '{"rows":[{"ticker":"NVDA","assetName":"NVIDIA Corp.","txDate":"2026-06-03","txType":"S","amountMin":50001,"amountMax":100000,"owner":"self","assetType":"Stock","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":"New","subholding":null,"location":null,"description":null,"supplementalText":"Notification date 2026-06-05","confidence":0.93}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:20:02.500Z', '2026-07-13T12:20:03.500Z', NULL, NULL, '2026-07-13T12:20:03.500Z'),
  ('PREVIEW-BENCH-EXEC', 'PREVIEW-BENCH-DOC-EXEC', 'anthropic', 'claude-haiku-4-5', 'claude-haiku-preview', 1, 1, 'would_publish', 1, NULL, 1, 0.92, 1900, 0.005, 'usage_priced', '{"source":"synthetic_preview_fixture"}', NULL, '{"promptTokens":1600,"completionTokens":260}', '{"rows":[{"ticker":"NVDA","assetName":"NVIDIA Corp.","txDate":"2026-06-03","txType":"S","amountMin":50001,"amountMax":100000,"owner":"self","assetType":"Stock","assetTypeName":"Stock","isOption":false,"capGainsOver200":false,"rawText":"synthetic preview fixture","filingStatus":"New","subholding":null,"location":null,"description":null,"supplementalText":"Notification date 2026-06-05","confidence":0.92}],"flags":[]}', 1, 1, 0, 0, '2026-07-13T12:20:03.500Z', '2026-07-13T12:20:05.400Z', NULL, NULL, '2026-07-13T12:20:05.400Z');
