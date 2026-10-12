/**
 * One agent, several computers — how the CLI prints an agent's connections.
 *
 * The pod lists each agent's LIVE connections (`GET /agent-users?mine=1` →
 * `connections`), one per computer, already named through its one naming
 * door ("Claude Code on devbox"): the CLI prints that name, never builds its
 * own. A connection from an older CLI carries no computer name and reads
 * "unlabelled (older CLI)". An older pod sends no `connections` at all: that
 * is "cannot tell", never "no connection".
 */

import { timeAgo } from "./time-ago.js";

export interface PodConnection {
  keyId: string;
  instanceId: string | null;
  instanceLabel: string | null;
  /** The pod's name for it: "Claude Code on devbox". */
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const UNLABELLED_COMPUTER = "unlabelled (older CLI)";

/**
 * One line per connection, or `null` when the pod sent no list (older pod).
 * `thisInstanceId` marks the connection made from THIS computer.
 */
export function connectionLines(
  connections: PodConnection[] | undefined | null,
  opts: { thisInstanceId?: string; now?: number } = {}
): string[] | null {
  if (!Array.isArray(connections)) return null;
  return connections.map((c) => {
    const name = c.instanceLabel?.trim()
      ? c.displayName
      : `${c.displayName} — ${UNLABELLED_COMPUTER}`;
    const used = c.lastUsedAt ? `last used ${timeAgo(c.lastUsedAt, opts.now)}` : "never used";
    const here = opts.thisInstanceId && c.instanceId === opts.thisInstanceId ? " (this computer)" : "";
    return `${name} · ${used}${here}`;
  });
}
