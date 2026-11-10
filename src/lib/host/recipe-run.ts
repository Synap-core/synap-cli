/**
 * The host runner's `verb` executor (hosted verbs, plan b647769e §3.2, plan
 * 64072312 U8): run ONE recipe of a tool installed on this computer, with
 * nobody at the keyboard, for a job the pod queued (`computer.run_recipe`).
 *
 *   approved manifest ─▶ the recipe (`findRecipe`), the OS's pinned programs
 *     ─▶ a fresh folder for this job: in/, out/, scripts/
 *     ─▶ each input file downloaded from the link the lease signed
 *     ─▶ each helper script written ONLY if its sha256 matches
 *     ─▶ `renderRecipe` (the one rule, ported in recipe.ts) ─▶ each step as an
 *        argv (never a shell), with the worker's PATH, in the job's folder
 *     ─▶ each `output` param uploaded through the pod (minted for the person
 *        who asked) ─▶ the folder removed, whatever happened.
 *
 * Nothing here decides WHERE it runs or WHETHER it may: the pod chose this
 * computer (the tool is installed and checked here) and the gate decided the
 * run before it was queued. No AI in this path.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeSecretFileNoFollow } from "../atomic-file.js";
import { renderRecipe, findRecipe, type Recipe } from "./recipe.js";
import { fillPlaceholders, redactSecrets, type PlaceholderValues } from "./tool.js";
import { onPath, runProcess, toolsHome } from "./tool-run.js";
import { HOST_VERB_MAX_FILES, type FinishStep, type HostHub, type HostJobFile, type LeasedHostJob } from "./wire.js";

/** One step of a recipe runs at most this long (a 4K export is long; a hang is not). */
export const RECIPE_STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** A failed step's detail keeps the end of what the program said. */
const DETAIL_TAIL = 900;

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  gif: "image/gif",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  json: "application/json",
  txt: "text/plain",
};

export function mimeOf(name: string): string {
  return MIME[path.extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** A bare file name: what the pod accepted as an output (`outputNameProblem`), checked again here. */
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export class RecipeFailure extends Error {}

export interface RecipeRunDeps {
  hub: Pick<HostHub, "upload">;
  /** The OS and the placeholder values of this computer (`localPlaceholders`). */
  os: string;
  values: PlaceholderValues;
  env: NodeJS.ProcessEnv;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  run?: typeof runProcess;
  /** Stop the running step (a person's Stop, the runner shutting down). */
  signal?: AbortSignal;
  /** Called once everything is ready and before the first step runs (the RUNNING heartbeat). */
  beforeSteps?: () => Promise<void>;
  /** Called between steps: throws when the job must end (lease gone, stop asked). */
  assertGoing?: () => void;
  /** Where jobs' folders go (default `~/.synap/tools/work`). */
  workRoot?: string;
  stepTimeoutMs?: number;
  /** Values never sent in a step's detail (the computer's own key, …). */
  secrets?: string[];
  log?: (line: string) => void;
}

export interface RecipeRunResult {
  steps: FinishStep[];
  files: HostJobFile[];
  /** Plain words for the log. */
  message: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The OS's pinned programs (`install.<os>.bins`), with this computer's placeholders filled. */
function pinnedBins(manifest: Record<string, unknown>, os: string, values: PlaceholderValues): Record<string, string> {
  const spec = (manifest.spec && typeof manifest.spec === "object" ? manifest.spec : manifest) as Record<string, unknown>;
  const install = (spec.install ?? {}) as Record<string, { bins?: Record<string, string> } | undefined>;
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(install[os]?.bins ?? {})) {
    const f = fillPlaceholders(raw, values);
    if ("error" in f) throw new RecipeFailure(`the pinned ${name}: ${f.error}`);
    out[name] = f.value;
  }
  return out;
}

/**
 * Run the job's recipe. Throws `RecipeFailure` (or whatever `assertGoing`
 * throws) with the steps so far on `err.steps`; the caller finishes the job.
 */
export async function runRecipe(job: LeasedHostJob, deps: RecipeRunDeps): Promise<RecipeRunResult> {
  const steps: FinishStep[] = [];
  const run = deps.run ?? runProcess;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const say = deps.log ?? (() => {});
  const fail = (name: string, detail: string): never => {
    let masked = redactSecrets(detail);
    for (const secret of deps.secrets ?? []) if (secret) masked = masked.split(secret).join("[redacted]");
    steps.push({ name, ok: false, detail: masked.slice(0, 1000) });
    const e = new RecipeFailure(detail);
    (e as RecipeFailure & { steps: FinishStep[] }).steps = steps;
    throw e;
  };

  const found = findRecipe(job.installation.manifest ?? {}, job.spec.recipe);
  if ("error" in found) return fail("recipe", found.error);
  const recipe: Recipe = found;

  const dir = path.join(deps.workRoot ?? path.join(toolsHome(), "work"), `job-${job.id}`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const sub of ["in", "out", "scripts"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const values: Record<string, unknown> = { ...job.parameters };

    // Inputs: each file param becomes the local copy of the file the lease signed.
    const t0 = Date.now();
    for (const [param, def] of Object.entries(recipe.params)) {
      if (def.type !== "file" && def.type !== "files") continue;
      if (values[param] === undefined) continue;
      const files = job.inputs?.[param] ?? [];
      if (files.length === 0) fail("download inputs", `${param}: the pod sent no link for this file`);
      const local: string[] = [];
      for (const f of files) {
        if (!BARE_NAME.test(f.name)) fail("download inputs", `${param}: ${JSON.stringify(f.name)} is not a bare file name`);
        const to = path.join(dir, "in", f.name);
        const res = await fetchImpl(f.url, { signal: deps.signal });
        if (!res.ok || !res.body) fail("download inputs", `${param}: the download answered HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream), fs.createWriteStream(to));
        local.push(to);
      }
      values[param] = def.type === "files" ? local : local[0];
    }
    if (Object.keys(job.inputs ?? {}).length > 0) steps.push({ name: "download inputs", ok: true, durationMs: Date.now() - t0 });

    // Outputs: a bare name, written in this job's out/.
    const outputs: Array<{ param: string; name: string; at: string }> = [];
    for (const [param, def] of Object.entries(recipe.params)) {
      if (def.type !== "output" || values[param] === undefined) continue;
      const name = String(values[param]);
      if (!BARE_NAME.test(name) || name.includes("..")) fail("outputs", `${param}: ${JSON.stringify(name)} is not a bare file name`);
      const at = path.join(dir, "out", name);
      values[param] = at;
      outputs.push({ param, name, at });
    }
    if (outputs.length > HOST_VERB_MAX_FILES) fail("outputs", `the recipe writes ${outputs.length} files; a run returns at most ${HOST_VERB_MAX_FILES}`);

    // Scripts: written only when they are exactly what was approved.
    const scripts: Record<string, string> = {};
    for (const s of recipe.scripts ?? []) {
      if (!/^[a-z0-9][a-z0-9_-]*\.(py|sh)$/.test(s.name)) fail("scripts", `${s.name} is not a script file name`);
      if (sha256(s.source) !== s.sha256) fail("scripts", `${s.name} does not match its pinned sha256: refused`);
      const at = path.join(dir, "scripts", s.name);
      writeSecretFileNoFollow(at, s.source, { mode: 0o600 });
      scripts[s.name] = at;
    }

    let rendered;
    try {
      rendered = renderRecipe(recipe, values, { workdir: dir, scripts, bins: pinnedBins(job.installation.manifest ?? {}, deps.os, deps.values) });
    } catch (err) {
      return fail("fill the recipe", (err as Error).message);
    }

    await deps.beforeSteps?.();
    for (const [i, st] of rendered.entries()) {
      deps.assertGoing?.();
      // A recipe says `python`; a Mac ships only `python3`.
      const program = st.program === "python" && !onPath("python", deps.env) ? "python3" : st.program;
      const name = `${i + 1}. ${path.basename(program)}`;
      say(`${name} ${st.args.length} argument(s)`);
      const s0 = Date.now();
      const r = await run([program, ...st.args], {
        env: deps.env,
        cwd: dir,
        timeoutMs: deps.stepTimeoutMs ?? RECIPE_STEP_TIMEOUT_MS,
        signal: deps.signal,
      });
      deps.assertGoing?.();
      if (r.exitCode !== 0) {
        const said = (r.stderr || r.stdout).trim().slice(-DETAIL_TAIL);
        fail(name, `${r.error ?? `exited ${r.exitCode}`}${said ? `: ${said}` : ""}`);
      }
      steps.push({ name, ok: true, durationMs: Date.now() - s0 });
    }

    // Each output goes to the pod, as the work of whoever asked.
    const files: HostJobFile[] = [];
    for (const o of outputs) {
      deps.assertGoing?.();
      if (!fs.existsSync(o.at)) {
        files.push({ param: o.param, name: o.name, error: "the recipe did not write this file" });
        continue;
      }
      const size = fs.statSync(o.at).size;
      if (size === 0) {
        files.push({ param: o.param, name: o.name, error: "the recipe wrote an empty file" });
        continue;
      }
      try {
        const ticket = await deps.hub.upload(job, { filename: o.name, mimeType: mimeOf(o.name), size });
        const put = await fetchImpl(ticket.uploadUrl, {
          method: "PUT",
          headers: { ...ticket.headers, "Content-Length": String(size) },
          body: Readable.toWeb(fs.createReadStream(o.at)) as unknown as BodyInit,
          // Node's fetch streams a body only half-duplex.
          ...({ duplex: "half" } as Record<string, unknown>),
          signal: deps.signal,
        });
        if (!put.ok) throw new Error(`the upload answered HTTP ${put.status}`);
        files.push({ param: o.param, name: o.name, size, uploadToken: ticket.uploadToken });
      } catch (err) {
        // A lost lease stops everything; any other upload failure is said on the file.
        if ((err as Error).name === "HostLeaseLostError") throw err;
        files.push({ param: o.param, name: o.name, error: `not uploaded: ${(err as Error).message}`.slice(0, 500) });
      }
    }
    const sent = files.filter((f) => f.uploadToken).length;
    steps.push({ name: "upload outputs", ok: sent === outputs.length, ...(sent === outputs.length ? {} : { detail: files.filter((f) => f.error).map((f) => `${f.name}: ${f.error}`).join("; ").slice(0, 1000) }) });
    if (outputs.length > 0 && sent === 0) {
      const e = new RecipeFailure("no output reached the pod");
      (e as RecipeFailure & { steps: FinishStep[]; files: HostJobFile[] }).steps = steps;
      (e as RecipeFailure & { files: HostJobFile[] }).files = files;
      throw e;
    }
    return { steps, files, message: `${recipe.name}: ${rendered.length} step(s), ${sent} file(s) returned` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
