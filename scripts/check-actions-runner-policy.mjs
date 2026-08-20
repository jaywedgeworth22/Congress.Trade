import { readdir, readFile } from "node:fs/promises";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const workflowNames = (await readdir(workflowsDir))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const errors = [];
const allowedRunners = new Set([
  // Owned Mac runner (mac-xcode26-congress) — day-to-day xcodebuild compile
  // and TestFlight ship only. Do not move ios-build.yml / ios-ship.yml onto
  // GitHub-hosted macos. Do not schedule non-Xcode jobs onto these labels.
  "[self-hosted, macOS, ARM64, xcode26]",
  // GitHub-hosted Tahoe GM. The owned Mac is macOS 27 beta; App Store
  // review rejects those IPAs as INVALID_BINARY. Only the App Store GM
  // ship workflow may use this label. macos-latest stays forbidden.
  "macos-26",
  "ubuntu-latest",
]);

const fullCommitSha = /^[0-9a-f]{40}$/;

for (const name of workflowNames) {
  const text = await readFile(new URL(name, workflowsDir), "utf8");
  const lines = text.split("\n");

  if (name === "sentry-ci-report.yml") {
    for (const required of [
      "  report:\n    if: >-\n",
      "github.event.workflow_run.conclusion == 'failure'",
      "github.event.workflow_run.conclusion == 'timed_out'",
      "github.event.workflow_run.conclusion == 'startup_failure'",
      "github.event.workflow_run.event == 'schedule'",
    ]) {
      if (!text.includes(required)) {
        errors.push(`${name}: Sentry reporter must reject guaranteed no-op workflow completions before runner scheduling`);
        break;
      }
    }
  }

  for (const forbidden of [
    "macos-latest",
    "windows-latest",
    "sparse-checkout:",
  ]) {
    if (text.includes(forbidden)) {
      errors.push(`${name}: forbidden hosted-runner or billable-cache token: ${forbidden}`);
    }
  }

  if (text.includes("runs-on: macos-26") && name !== "ios-appstore-gm.yml") {
    errors.push(`${name}: macos-26 is only allowed on ios-appstore-gm.yml`);
  }

  // IOSENGINEERING-14: iOS compile + XCTest must fail the job.  Advisory
  // continue-on-error let red Mac builds merge.  Do not skip tests.
  if (name === "ios-build.yml") {
    if (/\bcontinue-on-error\s*:/.test(text)) {
      errors.push(`${name}: iOS compile+test must fail the job (no continue-on-error)`);
    }
    if (!/\bxcodebuild\s+test\b/.test(text)) {
      errors.push(`${name}: must run xcodebuild test (do not only build)`);
    }
    if (!text.includes("-only-testing:CongressTradeTests")) {
      errors.push(`${name}: must target CongressTradeTests (do not skip XCTest)`);
    }
    if (!text.includes("Executed [0-9]+ tests") || !text.includes("-lt 71")) {
      errors.push(`${name}: must assert at least 71 XCTest cases ran`);
    }
    if (!text.includes("name: xcodebuild (unsigned)")) {
      errors.push(`${name}: required-check job must keep name 'xcodebuild (unsigned)'`);
    }
    if (!text.includes("always() && !cancelled()")) {
      errors.push(`${name}: required-check wrapper must always report (not skip on Mac failure)`);
    }
  }

  lines.forEach((line, index) => {
    const runner = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
    if (runner) {
      const value = runner[1];
      if (!allowedRunners.has(value)) {
        errors.push(`${name}:${index + 1}: runner must be ubuntu-latest, macos-26 (GM ship only), or the Mac xcode26 label set`);
      }
      if (
        value.includes("oracle-ci") ||
        (/self-hosted/.test(value) && value !== "[self-hosted, macOS, ARM64, xcode26]")
      ) {
        errors.push(`${name}:${index + 1}: leftover Linux self-hosted / oracle-ci selector`);
      }
    }

    const action = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (/^\s*cache\s*:/.test(line)) {
      errors.push(`${name}:${index + 1}: GitHub Actions cache storage is disabled`);
    }
    if (!action || action[1].startsWith("./")) return;
    if (action[1].startsWith("actions/cache")) {
      errors.push(`${name}:${index + 1}: GitHub Actions cache storage is disabled`);
    }
    const at = action[1].lastIndexOf("@");
    const ref = at === -1 ? "" : action[1].slice(at + 1);
    if (!fullCommitSha.test(ref)) {
      errors.push(`${name}:${index + 1}: third-party action must be pinned to a full commit SHA`);
    }
    if (action[1].includes("/.github/workflows/")) {
      errors.push(`${name}:${index + 1}: reusable workflow runner policy is not locally auditable`);
    }
  });
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Actions policy OK: ${workflowNames.length} workflows use hosted Linux or the owned Mac xcodebuild runner.`);
