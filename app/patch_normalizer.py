import re

with open('src/extraction/normalizer.ts', 'r') as f:
    code = f.read()

# Import recordTradeLatencyCandidates
code = code.replace("import { MAX_PUBLISH_TRANSACTIONS_PER_FILING } from '../shared/limits.ts';",
"import { MAX_PUBLISH_TRANSACTIONS_PER_FILING } from '../shared/limits.ts';\nimport { recordTradeLatencyCandidates } from '../ingestion/tradeLatency.ts';")

# 1. saveReviewTransactions
code = code.replace(
'''  if (insertedIds.length) {
    await updateAppSearchIds(env, insertedIds);
  }

  return {''',
'''  if (insertedIds.length) {
    await updateAppSearchIds(env, insertedIds);
    await recordTradeLatencyCandidates(env, transactions.filter(t => insertedIds.includes(t.id)), new Date().toISOString());
  }

  return {''')

# 2. saveFilingTransactions
code = code.replace(
'''  if (insertedIds.length) {
    await updateAppSearchIds(env, insertedIds);
  }
  return insertedIds;''',
'''  if (insertedIds.length) {
    await updateAppSearchIds(env, insertedIds);
    await recordTradeLatencyCandidates(env, transactions.filter(t => insertedIds.includes(t.id)), new Date().toISOString());
  }
  return insertedIds;''')

# 3. persistTransactions
code = code.replace(
'''  if ((results[0]?.meta?.changes ?? 0) === 0) return [];
  const inserted = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))`,
    [proposedIdsJson],
  );
  return inserted.map((row) => row.id);''',
'''  if ((results[0]?.meta?.changes ?? 0) === 0) return [];
  const inserted = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))`,
    [proposedIdsJson],
  );
  const insertedIds = inserted.map((row) => row.id);
  if (insertedIds.length > 0) {
    await recordTradeLatencyCandidates(env, transactions.filter(t => insertedIds.includes(t.id)), new Date().toISOString());
  }
  return insertedIds;''')

with open('src/extraction/normalizer.ts', 'w') as f:
    f.write(code)
