/**
 * Which revision is actually running.
 *
 * `app/scripts/ship.sh` does not itself deploy — Coolify redeploys on push to
 * `main`, and that webhook has failed silently before (see the 2026-07-31
 * board entry: "Coolify auto-deploy did NOT fire on the main merge"). Because
 * nothing in the response identified the running build, `ship.sh` would health-
 * check whichever revision happened to be live, migrate it, print success, and
 * an operator would reasonably report the new code as deployed while the
 * container still ran the old image.
 *
 * That happened on 2026-08-01: six merged security PRs were reported live while
 * production still served the previous build. Exporting the build SHA makes the
 * question answerable in one request, and lets ship.sh assert it.
 *
 * The value is supplied at image build time (Dockerfile ARG -> ENV) or by the
 * platform at runtime. Coolify sets `SOURCE_COMMIT`; we accept an explicit
 * `CT_BUILD_SHA` override first so any runtime can populate it.
 */

const UNKNOWN = 'unknown';

export interface BuildInfo {
  /** Full commit SHA of the running build, or 'unknown' if not supplied. */
  sha: string;
  /** First 12 chars of `sha`, for logs and human comparison. */
  shortSha: string;
}

/** Read the build revision from an env-like record. */
export function readBuildInfo(env: Record<string, string | undefined> | undefined): BuildInfo {
  const raw =
    env?.CT_BUILD_SHA ||
    env?.SOURCE_COMMIT ||
    env?.GIT_COMMIT_SHA ||
    env?.GITHUB_SHA ||
    '';
  const sha = raw.trim();
  // Only accept something that actually looks like a git object name; an
  // empty-string build arg otherwise shows up as a confident-looking ''.
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { sha: UNKNOWN, shortSha: UNKNOWN };
  return { sha: sha.toLowerCase(), shortSha: sha.toLowerCase().slice(0, 12) };
}
