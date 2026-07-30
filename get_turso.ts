import { InfisicalClient } from '@infisical/sdk';
const client = new InfisicalClient({
    clientId: process.env.INFISICAL_APP_CLIENT_ID,
    clientSecret: process.env.INFISICAL_APP_CLIENT_SECRET,
});
async function main() {
    const url = await client.getSecret({
        environment: "production",
        projectId: process.env.INFISICAL_APP_PROJECT_ID,
        path: "/",
        secretName: "TURSO_DATABASE_URL"
    });
    const token = await client.getSecret({
        environment: "production",
        projectId: process.env.INFISICAL_APP_PROJECT_ID,
        path: "/",
        secretName: "TURSO_AUTH_TOKEN"
    });
    console.log("URL:", url.secretValue);
    console.log("TOKEN:", token.secretValue);
}
main();
