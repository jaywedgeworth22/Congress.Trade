import { InfisicalClient } from 'npm:@infisical/sdk';
import { load } from "https://deno.land/std/dotenv/mod.ts";

async function main() {
    const env = await load({ envPath: '.dev.vars' });
    const client = new InfisicalClient({
        clientId: env.INFISICAL_APP_CLIENT_ID,
        clientSecret: env.INFISICAL_APP_CLIENT_SECRET,
    });
    const url = await client.getSecret({
        environment: "production",
        projectId: env.INFISICAL_APP_PROJECT_ID,
        path: "/",
        secretName: "TURSO_DATABASE_URL"
    });
    const token = await client.getSecret({
        environment: "production",
        projectId: env.INFISICAL_APP_PROJECT_ID,
        path: "/",
        secretName: "TURSO_AUTH_TOKEN"
    });
    console.log("URL:", url.secretValue);
    console.log("TOKEN:", token.secretValue);
}
main();
