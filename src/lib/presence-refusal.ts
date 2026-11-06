/**
 * Proof of presence (pod W3, 6 Nov 2026): a pod that enforces it refuses a
 * sensitive act — rotating a key, minting an app key, changing how an agent's
 * changes land — unless the PERSON confirms it is them (Face ID, Touch ID or a
 * passkey). The CLI holds a key, and a key can never give that proof. So the
 * CLI says so and sends the person to the pod admin page where they do it,
 * instead of failing with the pod's raw refusal.
 */
import { log } from "../utils/logger.js";
import { POD_ERROR_CODES } from "./pod-errors.js";
import { openPodPage, podAdminOrigin } from "./safe-open.js";

/** Did the pod refuse this for want of the person's proof of presence? */
export function isPresenceRefusal(err: unknown): boolean {
  // A Hub REST refusal (HubError) carries `code`; a tRPC one, `reasonCode`.
  const e = err as { code?: unknown; reasonCode?: unknown } | null;
  return (
    e?.code === POD_ERROR_CODES.presenceRequired ||
    e?.reasonCode === POD_ERROR_CODES.presenceRequired
  );
}

/**
 * Tell the person this needs them, name the pod admin page, and open it.
 * Returns the page's URL (null when the pod's admin origin is unknown).
 */
export function needsYouInPodAdmin(args: {
  podUrl: string;
  /** Pod admin's path, e.g. `/agents/<id>`. */
  page: string;
  /** What they do there, e.g. "choose how this agent's changes land". */
  what: string;
  open?: (url: string) => void;
}): string | null {
  const admin = podAdminOrigin(args.podUrl);
  const url = admin ? `${admin}${args.page}` : null;
  log.warn(
    `This needs you: ${args.what} in pod admin${url ? ` (${url})` : ""}, where you confirm it is you with Face ID, Touch ID or a passkey. A key cannot.`
  );
  if (url) openPodPage(url, args.podUrl, args.open);
  return url;
}
