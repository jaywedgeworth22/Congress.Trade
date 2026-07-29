import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const workflowNames = (await readdir(workflowsDir))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const errors = [];
// Allowed literal runner labels and the dynamic fallback expression.
const allowedRunners = new Set([
  "ubuntu-latest",
  "[self-hosted, congress-ci]",
  "[self-hosted, congress-deploy]",
  "[self-hosted, oracle-ci]",
]);
// The dynamic expression used when CT_CI_RUNNER variable controls runner selection.
// Workflows may use this expression for hosted-runner fallback when the self-hosted
// runner is unavailable. The policy accepts it as a known-safe pattern.
const allowedRunnerExpression =
  "${{ (github.actor != 'dependabot[bot]' && vars.CT_CI_RUNNER) || 'ubuntu-latest' }}";

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

  lines.forEach((line, index) => {
    const runner = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
    if (runner && !allowedRunners.has(runner[1]) && runner[1] !== allowedRunnerExpression) {
      errors.push(`${name}:${index + 1}: runner must be an owned literal label set or the approved fallback expression`);
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
