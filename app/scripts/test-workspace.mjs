const baseUrl = process.env.INFISICAL_URL || 'https://app.infisical.com';
const appClientId = process.env.INFISICAL_CLIENT_ID;
const appClientSecret = process.env.INFISICAL_CLIENT_SECRET;

async function getWorkspaces() {
  if (!appClientId || !appClientSecret) {
    console.error('Set INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET env vars');
    process.exit(1);
  }
  const loginRes = await fetch(`${baseUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: appClientId, clientSecret: appClientSecret })
  });
  const loginData = await loginRes.json();
  const token = loginData.accessToken;
  if (!token) return console.log('No token');

  const wsRes = await fetch(`${baseUrl}/api/v1/workspace`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const wsData = await wsRes.json();
  console.log('Workspaces:', JSON.stringify(wsData, null, 2));
}

getWorkspaces().catch(console.error);
