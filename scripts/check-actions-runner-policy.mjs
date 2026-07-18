import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const workflowNames = (await readdir(workflowsDir))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const errors = [];
const allowedRunners = new Set([
  "[self-hosted, congress-ci]",
  "[self-hosted, congress-deploy]",
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
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
    "CT_CI_RUNNER",
    "CT_DEPLOY_VERIFY_RUNNER",
    "sparse-checkout:",
  ]) {
    if (text.includes(forbidden)) {
      errors.push(`${name}: forbidden hosted-runner or billable-cache token: ${forbidden}`);
    }
  }

  lines.forEach((line, index) => {
    const runner = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
    if (runner && !allowedRunners.has(runner[1])) {
      errors.push(`${name}:${index + 1}: runner must be an owned literal label set`);
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

console.log(`Actions policy OK: ${workflowNames.length} workflows use owned runners only.`);
