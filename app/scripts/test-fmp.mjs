const baseUrl = 'https://app.infisical.com';

const appClientId = '0be350b7-598a-4ac8-8497-81dc3c53ec44';
const appClientSecret = '1cb5dda1d8704005394065ff9902353c266f3554b95fcc8b3ad1a64a615acbb5';
const workspaceId = 'f61a79de-8d77-4f0b-9361-4b7208598290';

async function testFmp() {
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
