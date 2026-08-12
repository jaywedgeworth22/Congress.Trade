#!/usr/bin/env node
/**
 * Minimal App Store Connect API client. No dependencies beyond Node's
 * built-in crypto (ES256 JWT signing) and fetch (Node 18+).
 *
 * Auth: reads ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH from
 * ~/.secrets/appstore-connect.env (never prints values -- see
 * scripts/infisical-secrets-safe.sh pattern used elsewhere in the fleet).
 *
 * Usage:
 *   node asc-api.mjs GET /v1/apps
 *   node asc-api.mjs GET "/v1/apps?filter[bundleId]=trade.socratic.app"
 *   node asc-api.mjs PATCH /v1/betaAppReviewDetails/<id> '{"data":{...}}'
 *   node asc-api.mjs latest-build-seq <bundleId> <prefix>   # e.g. ... trade.congress.ios 1.0
 *
 * Prints the raw JSON response to stdout. Caller is responsible for not
 * echoing anything secret-shaped from the response (ASC responses don't
 * carry credentials, only app metadata, so this is safe to print as-is).
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

function loadEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt({ keyId, issuerId, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: issuerId, iat: now, exp: now + 1190, aud: "appstoreconnect-v1" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // ASC requires the JOSE (r||s) signature encoding, not DER.
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  const encodedSig = signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${encodedSig}`;
}

async function main() {
  const envPath = join(homedir(), ".secrets", "appstore-connect.env");
  const env = loadEnvFile(envPath);
  const keyId = env.ASC_KEY_ID;
  const issuerId = env.ASC_ISSUER_ID;
  const keyPath = env.ASC_KEY_PATH;
  if (!keyId || !issuerId || !keyPath) {
    console.error("Missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH in ~/.secrets/appstore-connect.env");
    process.exit(1);
  }
  const privateKeyPem = readFileSync(keyPath, "utf8");
  const token = signJwt({ keyId, issuerId, privateKeyPem });

  const [method, path, body] = process.argv.slice(2);
  if (!method || !path) {
    console.error("Usage: node asc-api.mjs <METHOD> <PATH> [JSON_BODY]");
    console.error("       node asc-api.mjs ensure-tf-ready <bundleId>");
    console.error("       node asc-api.mjs latest-build-seq <bundleId> <prefix>");
    process.exit(1);
  }

  async function api(methodName, apiPath, jsonBody) {
    const url = apiPath.startsWith("http") ? apiPath : `https://api.appstoreconnect.apple.com${apiPath}`;
    const res = await fetch(url, {
      method: methodName,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: jsonBody ? jsonBody : undefined
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, ok: res.ok, parsed, text };
  }

  // Highest N among builds whose version is exactly "<prefix>.N" (e.g. 1.0.7).
  // This is what makes App Store Connect -- not a single unbacked local file --
  // the source of truth for "what has already shipped", so a lost/reset counter
  // cannot silently reuse a build number that ASC rejects as duplicate.
  //
  // stdout: the integer N (0 when the train has no builds yet). stderr: notes.
  // exit 0 = authoritative answer; exit 2 = could not determine (caller must
  // treat that as "unverified", NOT as zero).
  //
  // Legacy timestamp builds (e.g. 202608120521) do not match "<prefix>.N" and
  // are ignored on purpose: they live in the old 1.0.0 marketing train.
  if (method === "latest-build-seq") {
    const bundleId = path;
    const prefix = body;
    if (!bundleId || !prefix) {
      console.error("Usage: node asc-api.mjs latest-build-seq <bundleId> <prefix>");
      process.exit(2);
    }
    const apps = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
    if (!apps.ok || !apps.parsed.data?.[0]) {
      console.error(`latest-build-seq: app not found for bundle (HTTP ${apps.status})`);
      process.exit(2);
    }
    const appId = apps.parsed.data[0].id;

    // Escape the prefix so "1.0" cannot match "120" via the regex dot.
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}\\.(\\d+)$`);

    let url = `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=200`;
    let best = 0;
    let seen = 0;
    for (let page = 0; page < 10 && url; page++) {
      const res = await api("GET", url);
      if (!res.ok) {
        console.error(`latest-build-seq: builds query failed (HTTP ${res.status})`);
        process.exit(2);
      }
      for (const b of res.parsed.data || []) {
        seen++;
        const m = re.exec(b.attributes?.version || "");
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > best) best = n;
        }
      }
      url = res.parsed.links?.next || "";
    }
    console.error(`latest-build-seq: ${seen} build(s) inspected; highest ${prefix}.N is N=${best}`);
    console.log(String(best));
    process.exit(0);
  }

  // After upload: declare export compliance (standard HTTPS-only apps) and
  // wait until internal testers can actually install. Prints status only.
  if (method === "ensure-tf-ready") {
    const bundleId = path;
    const apps = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
    if (!apps.ok || !apps.parsed.data?.[0]) {
      console.error(`ensure-tf-ready: app not found for bundle (HTTP ${apps.status})`);
      process.exit(2);
    }
    const appId = apps.parsed.data[0].id;
    const builds = await api("GET", `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=1&include=buildBetaDetail`);
    if (!builds.ok || !builds.parsed.data?.[0]) {
      console.error(`ensure-tf-ready: no builds (HTTP ${builds.status})`);
      process.exit(2);
    }
    const build = builds.parsed.data[0];
    const buildId = build.id;
    const version = build.attributes?.version;
    let enc = build.attributes?.usesNonExemptEncryption;
    let beta = (builds.parsed.included || []).find((x) => x.type === "buildBetaDetails")?.attributes || {};
    console.error(`ensure-tf-ready: build=${version} enc=${enc} internal=${beta.internalBuildState || "unknown"}`);

    if (enc !== false) {
      const patch = await api("PATCH", `/v1/builds/${buildId}`, JSON.stringify({
        data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption: false } }
      }));
      if (!patch.ok) {
        console.error(`ensure-tf-ready: compliance patch failed HTTP ${patch.status}`);
        process.exit(2);
      }
      console.error("ensure-tf-ready: declared usesNonExemptEncryption=false");
    }

    for (let i = 0; i < 12; i++) {
      const again = await api("GET", `/v1/builds/${buildId}?include=buildBetaDetail`);
      const attrs = again.parsed.data?.attributes || {};
      const detail = (again.parsed.included || []).find((x) => x.type === "buildBetaDetails")?.attributes || {};
      const state = detail.internalBuildState || "";
      console.error(`ensure-tf-ready: poll ${i + 1} enc=${attrs.usesNonExemptEncryption} internal=${state}`);
      if (state === "IN_BETA_TESTING" || state === "READY_FOR_BETA_TESTING") {
        console.log(JSON.stringify({
          ok: true,
          buildId,
          version,
          internalBuildState: state,
          usesNonExemptEncryption: attrs.usesNonExemptEncryption
        }));
        process.exit(0);
      }
      if (state === "PROCESSING_EXCEPTION" || state === "MISSING_COMPLIANCE" ) {
        // keep polling after patch
      }
      await new Promise((r) => setTimeout(r, 10000));
    }
    console.error("ensure-tf-ready: timed out waiting for IN_BETA_TESTING (upload may still be processing)");
    console.log(JSON.stringify({ ok: false, buildId, version, timedOut: true }));
    process.exit(3);
  }

  const url = path.startsWith("http") ? path : `https://api.appstoreconnect.apple.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? body : undefined
  });
  const text = await res.text();
  console.error(`HTTP ${res.status}`);
  console.log(text);
  if (!res.ok) process.exit(2);
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
