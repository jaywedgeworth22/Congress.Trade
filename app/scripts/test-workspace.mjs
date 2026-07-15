const baseUrl = 'https://app.infisical.com';

const appClientId = '0be350b7-598a-4ac8-8497-81dc3c53ec44';
const appClientSecret = '1cb5dda1d8704005394065ff9902353c266f3554b95fcc8b3ad1a64a615acbb5';

async function getWorkspaces() {
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
