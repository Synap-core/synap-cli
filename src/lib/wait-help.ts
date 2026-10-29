/**
 * `synap wait`'s exit codes and help text: kept apart from the command so the
 * CLI entry can show the help without loading the command module.
 */

export const WAIT_EXIT = { PASSED: 0, FAILED: 1, TIMEOUT: 2, INFRA: 3 } as const;

export const WAIT_HELP = `
What each kind waits for:
  devbox <job>      the devbox job of that name (gate.sh, q.sh, runlocked.sh) to finish a
                    run that ended after the wait started (see --since). Reads
                    \`ssh devbox python3 ~/wt/devbox-status.py --name <job>\` every 30 s.
  pr <repo>#<n>     --for checks (default): every check on the PR (or the --checks list) to
                    complete. --for merged: the PR to be merged or closed. A bare repo name
                    means Synap-core/<repo>. Reads \`gh pr view\` every 60 s.
  run <url|id>      a GitHub Actions run to complete. Reads \`gh run view\` every 60 s.

It prints one line per state change and a final summary, and keeps its state in
~/.synap/waits/<conversation>/<id>.json, which the Claude Code status line shows.

Exit codes:
  0  passed (devbox green; every check success/skipped/neutral; merged; run success)
  1  failed (a red gate; a failed or cancelled check; closed unmerged; run failed)
  2  timeout (--timeout, default 4h)
  3  infra (devbox infra / died / refused / NOT-RUN), or the probe kept failing until the timeout
`;
