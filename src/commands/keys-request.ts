/**
 * synap keys request <template> — a machine asks for a scoped pod key.
 *
 * The device-flow the pod speaks (`synap-backend/.../services/key-requests.ts`):
 * file a request with this machine's own key, the person approves (or narrows)
 * it on the pod-admin page, this command collects the key once. The key is
 * written to a 0600 file and never reaches stdout unless `--print` is given.
 * A request lives 15 min on the pod, so an unanswered one is filed again until
 * `--wait` runs out: the person can approve whenever they look.
 *
 * Exit codes: 0 approved, 1 denied or refused, 2 timed out.
 */

import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  resolveHubConfig,
  hubGet,
  hubPost,
  HubError,
  HubNetworkError,
} from "../lib/hub-client.js";
import { writeFileAtomic } from "../lib/atomic-file.js";

export const EXIT_APPROVED = 0;
export const EXIT_DENIED = 1;
export const EXIT_TIMED_OUT = 2;

const DEFAULT_WAIT_MS = 24 * 60 * 60 * 1000;
const MIN_POLL_S = 5;
const RETRY_S = 30;
const DEFAULT_ENV_NAME = "SYNAP_HUB_API_KEY";

export interface KeysRequestOpts {
  template: string;
  name?: string;
  expiresDays?: number;
  workspace?: string;
  out?: string;
  force?: boolean;
  print?: boolean;
  /** Duration such as 90s, 30m, 24h. Default 24h. */
  wait?: string;
  /** commander turns `--no-wait` into `wait: false`. */
  noWait?: boolean;
  envName?: string;
}

interface KeyRequestFiled {
  request_code: string;
  request_id: string;
  review_url: string;
  expires_in: number;
  interval: number;
}

interface KeyCollected {
  apiKey: string;
  keyId: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
}

/** What the command needs from the outside, so the flow can run against a stub. */
export interface KeysRequestDeps {
  podUrl: string;
  post(path: string, body: unknown): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Status lines. Never the key. */
  log(line: string): void;
  /** The key itself, `--print` only. */
  printKey(key: string): void;
}

export function parseDuration(input: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "s"];
  return n * unit;
}

/** A pod restart, a deploy or the network: ask again, never give up on it. */
function isTransient(err: unknown): boolean {
  if (err instanceof HubNetworkError) return true;
  return err instanceof HubError && err.status >= 500;
}

function errorField(err: HubError): string | undefined {
  const b = err.body as { error?: unknown } | undefined;
  return b && typeof b.error === "string" ? b.error : undefined;
}

/** A filed request, kept beside --out so a rerun collects it instead of filing a second one. */
interface PendingRequest {
  requestId: string;
  requestCode: string;
  reviewUrl: string;
  interval: number;
  expiresAt: number;
  template: string;
  podUrl: string;
}

export const statePath = (out: string) => `${out}.request`;

function loadPending(out: string | undefined, opts: KeysRequestOpts, deps: KeysRequestDeps): PendingRequest | null {
  if (!out) return null;
  let p: PendingRequest;
  try {
    p = JSON.parse(fs.readFileSync(statePath(out), "utf8")) as PendingRequest;
  } catch {
    return null;
  }
  if (p.template !== opts.template || p.podUrl !== deps.podUrl || p.expiresAt <= deps.now()) {
    dropPending(out);
    return null;
  }
  return p;
}

function dropPending(out: string | undefined): void {
  if (out) fs.rmSync(statePath(out), { force: true });
}

export function envLines(podUrl: string, envName: string, key: string): string {
  return `SYNAP_POD_URL=${podUrl}\n${envName}=${key}\n`;
}

/** Refuse before filing anything: an approval with nowhere to put the key wastes the person's tap. */
export function checkDestination(opts: KeysRequestOpts): string | null {
  if (!opts.out && !opts.print) {
    return "Say where the key goes: --out <file> (0600 env lines) or --print (stdout).";
  }
  if (opts.noWait && !opts.out) {
    return "--no-wait needs --out: the pending request is saved beside it (<out>.request) so the same command can collect the key later.";
  }
  if (opts.out && fs.existsSync(opts.out) && !opts.force) {
    return `${opts.out} already exists. Pass --force to overwrite it.`;
  }
  return null;
}

export async function runKeysRequest(opts: KeysRequestOpts, deps: KeysRequestDeps): Promise<number> {
  const refusal = checkDestination(opts);
  if (refusal) {
    deps.log(refusal);
    return EXIT_DENIED;
  }
  const waitMs = opts.wait ? parseDuration(opts.wait) : DEFAULT_WAIT_MS;
  if (waitMs === null) {
    deps.log(`Cannot read --wait "${opts.wait}". Use a number and s, m, h or d, for example 24h.`);
    return EXIT_DENIED;
  }
  const deadline = deps.now() + waitMs;

  for (;;) {
    // 1. FILE, or resume the request saved beside --out
    let filed: KeyRequestFiled;
    const pending = loadPending(opts.out, opts, deps);
    if (pending) {
      filed = {
        request_code: pending.requestCode,
        request_id: pending.requestId,
        review_url: pending.reviewUrl,
        expires_in: 0,
        interval: pending.interval,
      };
      deps.log(`Resuming request ${pending.requestId}.`);
    } else {
      for (;;) {
        try {
          filed = (await deps.post("/keys/requests", {
            template: opts.template,
            ...(opts.name ? { name: opts.name } : {}),
            ...(opts.expiresDays ? { expiresInDays: opts.expiresDays } : {}),
            ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
          })) as KeyRequestFiled;
          break;
        } catch (err) {
          if (!isTransient(err)) {
            deps.log(`The pod refused the request: ${(err as Error).message}`);
            return EXIT_DENIED;
          }
          if (opts.noWait || deps.now() + RETRY_S * 1000 > deadline) {
            deps.log(`The pod could not be reached: ${(err as Error).message}`);
            return EXIT_TIMED_OUT;
          }
          await deps.sleep(RETRY_S * 1000);
        }
      }
      if (opts.out) {
        const state: PendingRequest = {
          requestId: filed.request_id,
          requestCode: filed.request_code,
          reviewUrl: filed.review_url,
          interval: filed.interval,
          expiresAt: deps.now() + filed.expires_in * 1000,
          template: opts.template,
          podUrl: deps.podUrl,
        };
        writeFileAtomic(statePath(opts.out), JSON.stringify(state), { mode: 0o600 });
      }
    }
    deps.log(`Approve the key here: ${filed.review_url}`);
    deps.log(`Request ${filed.request_id}`);
    if (opts.noWait) {
      deps.log(`Saved to ${statePath(opts.out!)}. Run the same command to collect the key once it is approved.`);
      return EXIT_APPROVED;
    }

    // 2. COLLECT, polling until approved, denied or expired
    let interval = Math.max(MIN_POLL_S, Number(filed.interval) || MIN_POLL_S);
    for (;;) {
      if (deps.now() >= deadline) {
        deps.log("Timed out before the key was approved. Run this again.");
        return EXIT_TIMED_OUT;
      }
      try {
        const key = (await deps.post("/keys/requests/token", {
          request_code: filed.request_code,
        })) as KeyCollected;
        if (!key.apiKey) {
          deps.log(`Approved, but the pod's answer carried no key (fields: ${Object.keys(key).sort().join(", ")}).`);
          return EXIT_DENIED;
        }
        return deliver(opts, deps, key);
      } catch (err) {
        if (isTransient(err)) {
          await deps.sleep(Math.max(interval, RETRY_S) * 1000);
          continue;
        }
        const code = err instanceof HubError && err.status === 400 ? errorField(err) : undefined;
        if (code === "authorization_pending") {
          await deps.sleep(interval * 1000);
          continue;
        }
        if (code === "slow_down") {
          interval += 5;
          await deps.sleep(interval * 1000);
          continue;
        }
        if (code === "expired_token") {
          deps.log("The request expired unanswered. Filing a new one.");
          dropPending(opts.out);
          break; // back to the outer loop: file again
        }
        if (code === "access_denied") {
          deps.log("The request was denied.");
          dropPending(opts.out);
          return EXIT_DENIED;
        }
        deps.log(`Stopped: ${(err as Error).message}`);
        return EXIT_DENIED;
      }
    }
  }
}

function deliver(opts: KeysRequestOpts, deps: KeysRequestDeps, key: KeyCollected): number {
  if (opts.out) {
    writeFileAtomic(opts.out, envLines(deps.podUrl, opts.envName || DEFAULT_ENV_NAME, key.apiKey), {
      mode: 0o600,
    });
    deps.log(`Key ${key.keyPrefix}… written to ${opts.out} (0600).`);
  }
  dropPending(opts.out);
  if (opts.print) deps.printKey(key.apiKey);
  if (key.scopes?.length) deps.log(`Scopes: ${key.scopes.join(", ")}`);
  if (key.expiresAt) deps.log(`Expires: ${key.expiresAt}`);
  return EXIT_APPROVED;
}

// ── CLI entry points ─────────────────────────────────────────────────────────

export async function keysRequest(opts: KeysRequestOpts): Promise<void> {
  const cfg = await resolveHubConfig({});
  const out = opts.out ? path.resolve(opts.out) : undefined;
  const code = await runKeysRequest(
    { ...opts, out },
    {
      podUrl: cfg.podUrl,
      post: (p, body) => hubPost(p, body, cfg),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: (line) => console.error(line),
      printKey: (k) => console.log(k),
    }
  );
  process.exit(code);
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  stored: boolean;
  expiresInDays?: number | null;
}

export async function keysListTemplates(): Promise<void> {
  const cfg = await resolveHubConfig({});
  const res = (await hubGet("/keys/templates", {}, cfg)) as { templates: TemplateRow[] };
  for (const t of res.templates) {
    const life = t.expiresInDays ? `${t.expiresInDays}d` : "no expiry";
    console.log(`${chalk.bold(t.id)}  ${t.name}  ${chalk.dim(`(${life})`)}`);
    if (t.description) console.log(`  ${chalk.dim(t.description)}`);
  }
}
