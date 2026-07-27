/**
 * Shared entity/proposal id shape helpers.
 *
 * The pod's ids are UUIDs. Never truncate an id that the user or an agent is
 * expected to feed back into another command (`synap get entity <id>`,
 * `synap proposals approve <id>`, …) — an 8-char prefix round-trips to a
 * 500 on the pod (it isn't a valid UUID). Truncate only in purely decorative
 * confirmations where the id itself was already supplied by the caller.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** True for a bare 8 hex-char string — the shape ids used to be printed in before this fix. */
export function looksTruncated(v: string): boolean {
  return /^[0-9a-f]{8}$/i.test(v);
}

/**
 * Fail fast, client-side, when a CLI argument that must be a full id isn't
 * one — a malformed id sent to the pod comes back as an opaque 500 (SQL type
 * mismatch), not a clean 404. Prints an error + a recovery hint and exits(1).
 */
export function requireFullId(id: string, kind: string, chalk: { red: (s: string) => string }, log: { hint: (s: string) => void }): void {
  if (isUuid(id)) return;
  console.error(chalk.red(`'${id}' isn't a full ${kind} id (expected a UUID).`));
  if (looksTruncated(id)) {
    log.hint(`That looks like an 8-char short id. Re-run the list/ask command and copy the FULL id it prints.`);
  } else {
    log.hint(`Copy the full id from the command that listed this ${kind}.`);
  }
  process.exit(1);
}
