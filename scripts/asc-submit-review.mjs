#!/usr/bin/env node
/**
 * Congress.Trade iOS 1.0.0 App Review resubmit.
 *
 * Uploads the physical-device account-deletion recording, updates review notes,
 * cancels the stale UNRESOLVED_ISSUES submission, creates a new IOS review
 * submission with the app version plus both Premium subscriptions, and submits.
 *
 * Auth: ~/.secrets/appstore-connect.env (never printed).
 * Usage:
 *   node scripts/asc-submit-review.mjs            # dry run
 *   node scripts/asc-submit-review.mjs --apply    # write to App Store Connect
 */
import { readFileSync, statSync } from "node:fs";
import { createHash, createSign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const APP = "6798076688";
const VERSION_ID = "7824c023-3f0c-41fa-abf6-be24d7fe217b";
const DETAIL_ID = "6bdc976e-ac42-44fd-9a95-4b33a4c14ac5";
const STALE_SUBMISSION = "b61e2a4a-ebb3-449d-83c6-170eb33feaa6";
const MONTHLY_ID = "6798078775";
const ANNUAL_ID = "6798078776";
const KEEP_BUILD = "202608202100";
const VIDEO_PATH = process.env.ASC_DELETION_VIDEO
  || join(homedir(), "apps/ios-fleet/artifacts/ct-account-deletion-2026-08-21.mp4");
const VIDEO_NAME = "account-deletion-physical-device.mp4";
const NOTES_PATH = process.env.ASC_REVIEW_NOTES
  || join(homedir(), "apps/congress-grok-asc-1-0/docs/asc/REVIEW-NOTES.txt");

function loadEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
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
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  const encodedSig = signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${encodedSig}`;
}

function errSummary(parsed) {
  const errs = parsed?.errors;
  if (!Array.isArray(errs) || errs.length === 0) return "";
  return errs.slice(0, 3).map((e) => e.detail || e.title || e.code || "error").join(" | ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const env = loadEnvFile(join(homedir(), ".secrets/appstore-connect.env"));
  if (!env.ASC_KEY_ID || !env.ASC_ISSUER_ID || !env.ASC_KEY_PATH) {
    console.error("missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH");
    process.exit(1);
  }
  const privateKeyPem = readFileSync(env.ASC_KEY_PATH, "utf8");
  const token = signJwt({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKeyPem });

  async function api(method, apiPath, jsonBody) {
    const url = apiPath.startsWith("http") ? apiPath : `https://api.appstoreconnect.apple.com${apiPath}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, ok: res.ok, parsed };
  }

  function needOk(label, res) {
    if (res.ok) return res;
    console.error(`${label}: HTTP ${res.status} ${errSummary(res.parsed)}`);
    process.exit(2);
  }

  console.log(APPLY ? "MODE apply" : "MODE dry-run");

  const st = statSync(VIDEO_PATH);
  console.log(`video bytes=${st.size} name=${VIDEO_NAME}`);
  const notes = readFileSync(NOTES_PATH, "utf8").trim();
  console.log(`notes chars=${notes.length}`);
  if (!notes.includes("physical-device") && !notes.includes("screen recording")) {
    console.error("notes do not mention a recording — refusing");
    process.exit(1);
  }

  const version = needOk("version", await api("GET", `/v1/appStoreVersions/${VERSION_ID}`));
  const vState = version.parsed.data?.attributes?.appStoreState;
  const vString = version.parsed.data?.attributes?.versionString;
  console.log(`version ${vString} state=${vState}`);

  const attached = needOk("attached-build", await api("GET", `/v1/appStoreVersions/${VERSION_ID}/build?fields[builds]=version,processingState,expired`));
  const buildVer = attached.parsed.data?.attributes?.version;
  const buildState = attached.parsed.data?.attributes?.processingState;
  console.log(`attached build=${buildVer} processing=${buildState}`);
  if (buildVer !== KEEP_BUILD) {
    console.error(`refusing: attached build ${buildVer} is not the recorded TestFlight ${KEEP_BUILD}`);
    process.exit(1);
  }

  const subs = needOk("subs", await api("GET", `/v1/apps/${APP}/subscriptionGroups?limit=5&include=subscriptions`));
  const subRows = (subs.parsed.included || []).filter((x) => x.type === "subscriptions");
  for (const s of subRows) {
    console.log(`subscription ${s.attributes.productId} state=${s.attributes.state} id=${s.id}`);
  }
  const monthly = subRows.find((s) => s.id === MONTHLY_ID);
  const annual = subRows.find((s) => s.id === ANNUAL_ID);
  if (!monthly || !annual) {
    console.error("missing Premium subscription ids");
    process.exit(1);
  }
  if (monthly.attributes.state !== "READY_TO_SUBMIT" || annual.attributes.state !== "READY_TO_SUBMIT") {
    console.error("subscriptions are not READY_TO_SUBMIT — Guideline 2.1(b) would fail again");
    process.exit(1);
  }

  const submissions = needOk("submissions", await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=10`));
  for (const item of submissions.parsed.data || []) {
    const a = item.attributes || {};
    console.log(`submission ${item.id} state=${a.state} submitted=${a.submitted}`);
  }

  const existingAtt = needOk("attachments", await api("GET", `/v1/appStoreReviewDetails/${DETAIL_ID}/appStoreReviewAttachments`));
  let haveVideo = false;
  const extraAttachments = [];
  for (const item of existingAtt.parsed.data || []) {
    const a = item.attributes || {};
    const stt = a.assetDeliveryState?.state;
    console.log(`attachment ${item.id} file=${a.fileName} bytes=${a.fileSize} state=${stt}`);
    if (a.fileName === VIDEO_NAME && stt === "COMPLETE") haveVideo = true;
    else extraAttachments.push({ id: item.id, fileName: a.fileName });
  }

  async function uploadVideo() {
    if (haveVideo) {
      console.log("video already COMPLETE — skip upload");
      return;
    }
    // App Review Information allows one attachment.  Replace any other file
    // (the existing IMG_1079.MP4 is not the owner-approved deletion clip).
    for (const extra of extraAttachments) {
      if (!APPLY) {
        console.log(`DRY RUN — would delete leftover attachment ${extra.fileName}`);
        continue;
      }
      const del = await api("DELETE", `/v1/appStoreReviewAttachments/${extra.id}`);
      if (!del.ok && del.status !== 204 && del.status !== 404) {
        console.error(`delete attachment ${extra.fileName}: HTTP ${del.status} ${errSummary(del.parsed)}`);
        process.exit(2);
      }
      console.log(`deleted leftover attachment ${extra.fileName}: HTTP ${del.status}`);
    }
    const bytes = readFileSync(VIDEO_PATH);
    const checksum = createHash("md5").update(bytes).digest("base64");
    if (!APPLY) {
      console.log(`DRY RUN — would reserve+upload ${VIDEO_NAME} (${bytes.length} bytes)`);
      return;
    }
    const reserved = await api("POST", "/v1/appStoreReviewAttachments", {
      data: {
        type: "appStoreReviewAttachments",
        attributes: { fileName: VIDEO_NAME, fileSize: bytes.length },
        relationships: {
          appStoreReviewDetail: { data: { type: "appStoreReviewDetails", id: DETAIL_ID } },
        },
      },
    });
    if (!reserved.ok) {
      console.error(`reserve attachment: HTTP ${reserved.status} ${errSummary(reserved.parsed)}`);
      process.exit(2);
    }
    const attId = reserved.parsed.data?.id;
    const ops = reserved.parsed.data?.attributes?.uploadOperations || [];
    console.log(`reserved attachment ${attId} parts=${ops.length} attrKeys=${Object.keys(reserved.parsed.data?.attributes || {}).join(",")}`);
    for (const [i, op] of ops.entries()) {
      const offset = op.offset || 0;
      const length = op.length || bytes.length;
      const headers = {};
      for (const h of op.requestHeaders || []) {
        if (h?.name) headers[h.name] = h.value;
      }
      const put = await fetch(op.url, {
        method: op.method || "PUT",
        headers,
        body: bytes.subarray(offset, offset + length),
      });
      if (!put.ok) {
        console.error(`upload part ${i + 1}/${ops.length}: HTTP ${put.status}`);
        process.exit(2);
      }
      console.log(`upload part ${i + 1}/${ops.length}: HTTP ${put.status}`);
    }
    const commit = await api("PATCH", `/v1/appStoreReviewAttachments/${attId}`, {
      data: {
        type: "appStoreReviewAttachments",
        id: attId,
        attributes: { uploaded: true, sourceFileChecksum: checksum },
      },
    });
    if (!commit.ok) {
      console.error(`commit attachment: HTTP ${commit.status} ${errSummary(commit.parsed)}`);
      process.exit(2);
    }
    console.log(`commit attachment: HTTP ${commit.status}`);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const poll = await api("GET", `/v1/appStoreReviewAttachments/${attId}`);
      const stt = poll.parsed.data?.attributes?.assetDeliveryState?.state;
      console.log(`attachment state=${stt}`);
      if (stt === "COMPLETE") return;
      if (stt === "FAILED") {
        console.error("attachment processing FAILED");
        process.exit(2);
      }
      await sleep(4000);
    }
    console.error("attachment did not reach COMPLETE in 180s");
    process.exit(2);
  }

  async function updateNotes() {
    if (!APPLY) {
      console.log("DRY RUN — would PATCH review notes");
      return;
    }
    const res = await api("PATCH", `/v1/appStoreReviewDetails/${DETAIL_ID}`, {
      data: {
        type: "appStoreReviewDetails",
        id: DETAIL_ID,
        attributes: { notes },
      },
    });
    if (!res.ok) {
      console.error(`notes: HTTP ${res.status} ${errSummary(res.parsed)}`);
      process.exit(2);
    }
    console.log(`notes: HTTP ${res.status} chars=${notes.length}`);
  }

  async function cancelStale() {
    const listed = needOk("submissions-before-cancel", await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=10`));
    const cur = (listed.parsed.data || []).find((s) => s.id === STALE_SUBMISSION);
    const state = cur?.attributes?.state;
    if (!cur) {
      console.log("stale submission not listed — skip cancel");
      return;
    }
    if (state === "CANCELLED" || state === "COMPLETE") {
      // After canceled:true, Apple often lands UNRESOLVED_ISSUES on COMPLETE
      // rather than CANCELLED.  Either way the version is free to resubmit.
      console.log(`stale submission already ${state} — skip cancel`);
      return;
    }
    if (!APPLY) {
      console.log(`DRY RUN — would cancel ${STALE_SUBMISSION} (state=${state})`);
      return;
    }
    const res = await api("PATCH", `/v1/reviewSubmissions/${STALE_SUBMISSION}`, {
      data: {
        type: "reviewSubmissions",
        id: STALE_SUBMISSION,
        attributes: { canceled: true },
      },
    });
    if (!res.ok) {
      console.error(`cancel: HTTP ${res.status} ${errSummary(res.parsed)}`);
      process.exit(2);
    }
    console.log(`cancel: HTTP ${res.status} now=${res.parsed.data?.attributes?.state}`);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const poll = await api("GET", `/v1/reviewSubmissions/${STALE_SUBMISSION}`);
      const stt = poll.parsed.data?.attributes?.state;
      console.log(`stale state=${stt}`);
      if (stt === "CANCELLED" || stt === "COMPLETE") return;
      await sleep(4000);
    }
    console.error("stale submission did not reach CANCELLED in 180s");
    process.exit(2);
  }

  async function createAndSubmit() {
    const listed = needOk("submissions-refresh", await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=10`));
    let ready = (listed.parsed.data || []).find((s) => {
      const stt = s.attributes?.state;
      return stt === "READY_FOR_REVIEW" || stt === "WAITING_FOR_REVIEW" || stt === "IN_REVIEW";
    });
    if (ready && (ready.attributes.state === "WAITING_FOR_REVIEW" || ready.attributes.state === "IN_REVIEW")) {
      console.log(`already ${ready.attributes.state} id=${ready.id} — nothing to submit`);
      return ready.id;
    }
    if (!APPLY) {
      console.log("DRY RUN — would create review submission, add version + monthly + annual, submit");
      return null;
    }
    if (!ready) {
      const created = await api("POST", "/v1/reviewSubmissions", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: APP } } },
        },
      });
      if (!created.ok) {
        console.error(`create submission: HTTP ${created.status} ${errSummary(created.parsed)}`);
        process.exit(2);
      }
      ready = created.parsed.data;
      console.log(`created submission ${ready.id} state=${ready.attributes?.state}`);
    } else {
      console.log(`reusing submission ${ready.id} state=${ready.attributes?.state}`);
    }
    const rsId = ready.id;

    async function addItem(relName, relType, relId, label) {
      const body = {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: rsId } },
            [relName]: { data: { type: relType, id: relId } },
          },
        },
      };
      const res = await api("POST", "/v1/reviewSubmissionItems", body);
      if (res.ok) {
        console.log(`item ${label}: HTTP ${res.status} id=${res.parsed.data?.id}`);
        return true;
      }
      const detail = errSummary(res.parsed);
      console.error(`item ${label}: HTTP ${res.status} ${detail}`);
      return false;
    }

    // 2026 ASC: IAP products are subscriptionVersion + subscriptionGroupVersion,
    // not relationship name "subscription" (that 409s ENTITY_ERROR.RELATIONSHIP.UNKNOWN).
    const MONTHLY_VERSION = "efbef974-f24c-4ebb-b0c2-a6017f722957";
    const ANNUAL_VERSION = "f85b493e-7dcf-463a-821d-6ce0a327ccbc";
    const GROUP_VERSION = "3a37da1c-75e9-4284-929f-50ab6821d721";
    const okVersion = await addItem("appStoreVersion", "appStoreVersions", VERSION_ID, "app version");
    const okGroup = await addItem("subscriptionGroupVersion", "subscriptionGroupVersions", GROUP_VERSION, "premium group");
    const okMonthly = await addItem("subscriptionVersion", "subscriptionVersions", MONTHLY_VERSION, "premium.monthly");
    const okAnnual = await addItem("subscriptionVersion", "subscriptionVersions", ANNUAL_VERSION, "premium.annual");
    if (!okVersion) {
      console.error("version item failed — not submitting");
      process.exit(2);
    }
    if (!okMonthly || !okAnnual || !okGroup) {
      console.error("subscription items failed — not submitting (Guideline 2.1(b) needs group + both products)");
      process.exit(2);
    }

    const submitted = await api("PATCH", `/v1/reviewSubmissions/${rsId}`, {
      data: {
        type: "reviewSubmissions",
        id: rsId,
        attributes: { submitted: true },
      },
    });
    if (!submitted.ok) {
      console.error(`submit: HTTP ${submitted.status} ${errSummary(submitted.parsed)}`);
      process.exit(2);
    }
    console.log(`submit: HTTP ${submitted.status} state=${submitted.parsed.data?.attributes?.state} submitted=${submitted.parsed.data?.attributes?.submitted}`);
    return rsId;
  }

  await uploadVideo();
  await updateNotes();
  await cancelStale();
  const rsId = await createAndSubmit();

  const verAfter = await api("GET", `/v1/appStoreVersions/${VERSION_ID}`);
  console.log(`final version state=${verAfter.parsed.data?.attributes?.appStoreState}`);
  const subAfter = await api("GET", `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=5`);
  for (const item of subAfter.parsed.data || []) {
    const a = item.attributes || {};
    console.log(`final submission ${item.id} state=${a.state} submitted=${a.submitted}`);
  }
  if (rsId) console.log(`reviewSubmission=${rsId}`);
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack.split("\n")[0] : err));
  process.exit(1);
});
