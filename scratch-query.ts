import { config } from 'dotenv';
import { execSync } from 'child_process';
config({ path: '/Users/jay/.secrets/global-api-keys.env' });
const json = execSync('curl -s https://congress.trade/api/analytics/latency-summary').toString();
console.log(json);
