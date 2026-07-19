/**
 * Project-ref resolution — the ONE door (P4-lite W3).
 *
 * A project ref can name a project on ANY pod the user can see, resolved via
 * the Control Plane directory (`GET /projects/resolve?ref=`). Every command
 * that accepts a project ref parses + resolves it HERE — no second ref parser
 * anywhere.
 *
 * Ref forms (ratified):
 *   - uuid                      → local: today's behavior, pinned against the active pod
 *   - `<pod-subdomain>/<slug>`  → canonical cross-pod form (e.g. perso/synap)
 *   - bare `<slug>`             → resolved when unique across visible pods; 300-ambiguous otherwise
 *
 * The directory is an ACCELERATOR, not a dependency: CP unreachable, not
 * logged in, or 404 all degrade to a graceful message — the uuid path never
 * touches the CP and keeps working.
 */

import { getStoredToken, getCpUrl } from "./auth.js";

// ─── Parsing ──────────────────────────────────────────────────────────────────

export type ParsedProjectRef =
  | { kind: "uuid"; id: string }
  | { kind: "fq"; pod: string; slug: string }
  | { kind: "slug"; slug: string }
  | { kind: "invalid"; reason: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pod subdomains and project slugs: alphanum with internal `-`/`_`/`.`. */
const PART_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

export function parseProjectRef(raw: string): ParsedProjectRef {
  const ref = raw.trim();
  if (!ref) return { kind: "invalid", reason: "empty project ref" };
  if (UUID_RE.test(ref)) return { kind: "uuid", id: ref.toLowerCase() };
  const parts = ref.split("/");
  if (parts.length === 2) {
    const [pod, slug] = parts;
    if (!PART_RE.test(pod) || !PART_RE.test(slug)) {
      return {
        kind: "invalid",
        reason: `"${ref}" is not a valid <pod>/<slug> ref (letters, digits, - _ . only)`,
      };
    }
    return { kind: "fq", pod: pod.toLowerCase(), slug: slug.toLowerCase() };
  }
  if (parts.length > 2) {
    return { kind: "invalid", reason: `"${ref}" has too many '/' — use <pod-subdomain>/<slug>` };
  }
  if (!PART_RE.test(ref)) {
    return {
      kind: "invalid",
      reason: `"${ref}" is not a project uuid, slug, or <pod>/<slug> ref`,
    };
  }
  return { kind: "slug", slug: ref.toLowerCase() };
}

// ─── CP resolution ────────────────────────────────────────────────────────────

/** One resolved project, as the CP directory returns it (200). */
export interface CpProjectResolution {
  projectId: string;
  /** Nullable in the CP mirror (pre-slug rows); render with a fallback. */
  slug: string | null;
  name: string;
  podId: string;
  podUrl: string;
  grant?: unknown;
}

/** A 300-ambiguous candidate — same shape, rendered as `pod/slug` hints. */
export type CpProjectCandidate = Partial<CpProjectResolution>;

export type ProjectRefResolution =
  /** uuid ref — no CP involved; caller keeps today's active-pod behavior. */
  | { kind: "local"; projectId: string }
  | { kind: "resolved"; project: CpProjectResolution; refPod?: string }
  | { kind: "ambiguous"; candidates: CpProjectCandidate[] }
  | { kind: "not-found"; ref: string }
  | { kind: "not-logged-in" }
  | { kind: "cp-error"; message: string }
  | { kind: "invalid"; reason: string };

/** Injectable seams for tests — production callers pass nothing. */
export interface ResolveDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => { token: string } | null;
  cpUrl?: string;
}

/**
 * Resolve a project ref. uuid short-circuits to `local` (today's behavior);
 * everything else goes through the CP directory with the CLI's CP credentials.
 */
export async function resolveProjectRef(
  raw: string,
  deps: ResolveDeps = {}
): Promise<ProjectRefResolution> {
  const parsed = parseProjectRef(raw);
  if (parsed.kind === "invalid") return { kind: "invalid", reason: parsed.reason };
  if (parsed.kind === "uuid") return { kind: "local", projectId: parsed.id };

  const creds = (deps.getToken ?? getStoredToken)();
  if (!creds?.token) return { kind: "not-logged-in" };

  const cpUrl = deps.cpUrl ?? getCpUrl();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ref = parsed.kind === "fq" ? `${parsed.pod}/${parsed.slug}` : parsed.slug;

  let res: Response;
  try {
    res = await fetchImpl(
      `${cpUrl}/projects/resolve?ref=${encodeURIComponent(ref)}`,
      {
        headers: { Authorization: `Bearer ${creds.token}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: "cp-error",
      message: `could not reach the project directory at ${cpUrl} (${detail})`,
    };
  }

  if (res.status === 300) {
    const body = (await res.json().catch(() => null)) as {
      candidates?: CpProjectCandidate[];
    } | null;
    return { kind: "ambiguous", candidates: body?.candidates ?? [] };
  }
  if (res.status === 404) return { kind: "not-found", ref };
  if (res.status === 401 || res.status === 403) return { kind: "not-logged-in" };
  if (!res.ok) {
    return { kind: "cp-error", message: `the project directory returned HTTP ${res.status}` };
  }

  const body = (await res.json().catch(() => null)) as CpProjectResolution | null;
  if (!body?.projectId || !body?.podUrl) {
    return { kind: "cp-error", message: "the project directory returned an incomplete resolution" };
  }
  return {
    kind: "resolved",
    project: body,
    refPod: parsed.kind === "fq" ? parsed.pod : undefined,
  };
}

// ─── Helpers shared by callers ────────────────────────────────────────────────

/** True when two pod URLs name the same origin (scheme+host+port). */
export function samePodOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

/**
 * Session-lens guard: the per-Claude-session lens has NO pod field, so a
 * `--session` pin can only target a project on the ACTIVE pod. Returns the
 * refusal message for a cross-pod ref, or null when the pin is allowed.
 */
export function sessionScopeRefusal(
  project: CpProjectResolution,
  activePodUrl: string | undefined
): string | null {
  if (samePodOrigin(activePodUrl, project.podUrl)) return null;
  return (
    `--session scopes only this Claude session, and the session lens has no pod field — ` +
    `it cannot bind a project on another pod (${project.podUrl}). ` +
    `Re-run without --session to switch the active pod, or pick a project on the active pod.`
  );
}

/** `pod/slug` label for a candidate row, degrading to whatever fields exist. */
export function candidateLabel(c: CpProjectCandidate): string {
  // The CP emits podUrl (never a subdomain field); derive the label from it.
  let pod: string | undefined;
  if (c.podUrl) {
    try {
      pod = new URL(c.podUrl).hostname;
    } catch {
      pod = c.podUrl;
    }
  }
  return `${pod ?? "?"}/${c.slug ?? c.projectId ?? "?"}`;
}
