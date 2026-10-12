/**
 * One agent, several computers — how the CLI prints an agent's connections.
 *
 * The pod lists each agent's LIVE connections (`GET /agent-users?mine=1` →
 * `connections`), one per computer. The agent's name is already the row it
 * sits under, so a connection reads as its COMPUTER only: "devbox (this
 * computer) · just now", or "unlabelled · 17 hours ago" when the key carries no
 * computer name. Never the agent name again, and never a guess about why it is
 * unlabelled. An older pod sends no `connections` at all: that is "cannot
 * tell", never "no connection".
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

/** A connection whose key carries no computer name. */
export const UNLABELLED_COMPUTER = "unlabelled";

/**
 * One short entry per connection, or `null` when the pod sent no list (older
 * pod). `isThisComputer` marks the connection made from THIS computer.
 * Most recently used first.
 */
export function connectionLines(
  connections: PodConnection[] | undefined | null,
  opts: { isThisComputer?: (instanceId: string) => boolean; now?: number } = {}
): string[] | null {
  if (!Array.isArray(connections)) return null;
  const when = (c: PodConnection) => Date.parse(c.lastUsedAt ?? "") || 0;
  return [...connections]
    .sort((a, b) => when(b) - when(a))
    .map((c) => {
      const computer = c.instanceLabel?.trim() || UNLABELLED_COMPUTER;
      const here = c.instanceId && opts.isThisComputer?.(c.instanceId) ? " (this computer)" : "";
      const used = c.lastUsedAt ? timeAgo(c.lastUsedAt, opts.now) : "never used";
      return `${computer}${here} · ${used}`;
    });
}
