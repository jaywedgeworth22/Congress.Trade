import { createClient } from "npm:@libsql/client";
import { load } from "https://deno.land/std/dotenv/mod.ts";

async function main() {
    const env = await load({ envPath: '.dev.vars' });
    
    const response = await fetch("https://app.infisical.com/api/v1/auth/universal-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            clientId: env.INFISICAL_APP_CLIENT_ID,
            clientSecret: env.INFISICAL_APP_CLIENT_SECRET
        })
    });
    const authData = await response.json();
    const token = authData.accessToken;

    const secretsRes = await fetch(`https://app.infisical.com/api/v3/secrets/raw?environment=prod&workspaceId=${env.INFISICAL_APP_PROJECT_ID}&secretPath=/`, {
        headers: { "Authorization": `Bearer ${token}` }
    });
    const secretsData = await secretsRes.json();
    const secrets = Object.fromEntries(secretsData.secrets.map((s: any) => [s.secretKey, s.secretValue]));

    const tursoUrl = secrets["TURSO_DATABASE_URL"];
    const tursoAuth = secrets["TURSO_AUTH_TOKEN"];

    console.log("Syncing from:", tursoUrl);
    
    const client = createClient({
        url: "file:data/app.db",
        syncUrl: tursoUrl,
        authToken: tursoAuth,
    });
    
    console.log("Starting sync...");
    await client.sync();
    console.log("Sync complete! Database downloaded to data/app.db");
}
main();
