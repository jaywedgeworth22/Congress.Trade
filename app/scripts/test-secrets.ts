import { resolveSecrets } from "../src/secrets/infisical.ts";
async function main() {
  const secrets = await resolveSecrets(process.env as any, ["CF_R2_S3_SECRET_ACCESS_KEY"]);
  console.log({ CF_R2_S3_SECRET_ACCESS_KEY: secrets.CF_R2_S3_SECRET_ACCESS_KEY ? "<REDACTED>" : "MISSING" });
}
main();
