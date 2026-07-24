import { execSync } from 'child_process';
import { config } from 'dotenv';

config({ path: '/Users/jay/.secrets/global-api-keys.env' });
const query = `
  SELECT * FROM disclosure_latency_candidates
  WHERE filer_name LIKE '%Himes%'
  ORDER BY filed_date DESC
  LIMIT 5;
`;
const res = execSync(`npx wrangler d1 execute DB --remote --command="${query.replace(/\n/g, ' ')}" --json`).toString();
console.log(res);
