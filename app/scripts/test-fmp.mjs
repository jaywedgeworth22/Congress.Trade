const baseUrl = process.env.INFISICAL_URL || 'https://app.infisical.com';
const appClientId = process.env.INFISICAL_CLIENT_ID;
const appClientSecret = process.env.INFISICAL_CLIENT_SECRET;
const workspaceId = process.env.INFISICAL_WORKSPACE_ID;

async function testFmp() {
  if (!appClientId || !appClientSecret) {
    console.error('Set INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET env vars');
    process.exit(1);
  }
  const loginRes = await fetch(`${baseUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: appClientId, clientSecret: appClientSecret })
  });
  const token = (await loginRes.json()).accessToken;
  
  const secretsRes = await fetch(`${baseUrl}/api/v3/secrets/raw?workspaceId=${workspaceId}&environment=prod&secretPath=/&include_imports=true&recursive=true`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const data = await secretsRes.json();
  const fmp = (data.secrets || []).find(s => s.secretKey === 'FMP_API_KEY' || s.key === 'FMP_API_KEY');
  const fmpKey = fmp.secretValue || fmp.value;
  
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/dividend-adjusted?symbol=BYND&from=2020-11-03&to=2026-07-14&apikey=${fmpKey}`;
  console.log('Fetching', url.replace(fmpKey, 'REDACTED'));
  const fmpRes = await fetch(url);
  const fmpData = await fmpRes.text();
  console.log('FMP response:', fmpData.slice(0, 500));
}
testFmp().catch(console.error);
