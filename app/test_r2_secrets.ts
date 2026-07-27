import { resolveSecret } from "./src/secrets/infisical.ts";

async function main() {
  const s3EpRes = await resolveSecret(Deno.env.toObject() as any, "AWS_S3_ENDPOINT");
  console.log("Endpoint:", s3EpRes.value);
  const s3IdRes = await resolveSecret(Deno.env.toObject() as any, "AWS_ACCESS_KEY_ID");
  console.log("Access Key:", s3IdRes.value);
}
main();
