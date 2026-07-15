import { execSync } from 'child_process';
const date = new Date().toISOString().slice(0, 10);
try {
  const res = execSync(`npx wrangler kv:key get fmp_daily_used_${date} --binding CONFIG_KV`).toString();
  console.log('KV:', res);
} catch (e) {
  console.log('Error reading KV or key not found');
}
