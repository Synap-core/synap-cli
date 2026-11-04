/**
 * The host runner (`synap host serve`, plan 64072312 U11): the compose writer's
 * refusals, the job loop's start order, cleanup on every failure path, a lost
 * or expired lease that is never reported, logs only on request and masked,
 * provider ops. All with fakes (no Docker, no pod); the real engine is
 * dogfooded on the devbox (U14).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ComposeRefusal,
  composeDocument,
  planInstallation,
  projectName,
  writeInstallation,
  type ComposeContext,
  type ContainerRuntime,
  type ContainerState,
  type InstallationPlan,
} from "../src/lib/host/compose.js";
import { runJob, serveHost, type RunnerDeps } from "../src/lib/host/lease.js";
import { maskSecrets, toHostLog } from "../src/lib/host/logs.js";
import { isTailnetIPv4, listenPortFor, parseProviderOp, planProviderOp, ProviderOpRefusal } from "../src/lib/host/provider-ops.js";
import {
  createHostHub,
  HOST_LOG_CAP,
  HostLeaseLostError,
  type FinishBody,
  type HeartbeatAnswer,
  type HostHub,
  type LeasedHostJob,
  type ReportBody,
} from "../src/lib/host/wire.js";

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const INST = "0f0e0d0c-0b0a-4908-8706-050403020100";
const BIND = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const KEY = "synap_live_THE_COMPUTERS_OWN_KEY_0123456789";

function manifest(over: Record<string, unknown> = {}, extraServices: unknown[] = []) {
  return {
    services: [
      {
        id: "render",
        image: `synap-hyperframes-render@${D1}`,
        limits: { cpus: 4, memoryMb: 6144, diskMb: 20000 },
        env: { HYPERFRAMES_NO_TELEMETRY: "1" },
        volumes: [{ name: "work", path: "/work" }],
      },
      {
        id: "studio",
        image: `synap-hyperframes-studio:0.9.12@${D2}`,
        ports: [{ container: 3045, host: 41001 }],
        health: { http: "/", port: 3045 },
        limits: { cpus: 2, memoryMb: 3072, diskMb: 1024 },
        ...over,
      },
      ...extraServices,
    ],
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synap-host-test-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ctx = (over: Partial<ComposeContext> = {}): ComposeContext => ({
  installationId: INST,
  installRoot: path.join(root, "installations"),
  digests: { render: D1, studio: D2 },
  user: "1001:1001",
  ...over,
});

function refusal(m: unknown, c: ComposeContext = ctx()): string[] {
  try {
    planInstallation(m, c);
  } catch (err) {
    expect(err).toBeInstanceOf(ComposeRefusal);
    return (err as ComposeRefusal).problems;
  }
  throw new Error("the manifest was accepted");
}

// ── the compose writer ───────────────────────────────────────────────────────

describe("compose writer", () => {
  it("writes the approved manifest as a hardened compose file: digests, 127.0.0.1 ports, limits, no outbound NAT", () => {
    const plan = planInstallation(manifest(), ctx());
    expect(plan.project).toBe(projectName(INST));
    const doc = composeDocument(plan, { user: "1001:1001" }) as {
      services: Record<string, Record<string, unknown>>;
      networks: Record<string, Record<string, unknown>>;
    };
    const studio = doc.services.studio;
    expect(studio.image).toBe(`synap-hyperframes-studio:0.9.12@${D2}`);
    expect(studio.ports).toEqual(["127.0.0.1:41001:3045/tcp"]);
    expect(studio.user).toBe("1001:1001");
    expect(studio.cap_drop).toEqual(["ALL"]);
    expect(studio.security_opt).toEqual(["no-new-privileges:true"]);
    expect(studio.read_only).toBe(true);
    expect(studio.mem_limit).toBe("3072m");
    expect(studio.cpus).toBe(2);
    expect(studio).not.toHaveProperty("privileged");
    expect(studio).not.toHaveProperty("network_mode");
    expect(studio.networks).toEqual(["installation"]);
    expect(doc.networks.installation.driver_opts).toEqual({ "com.docker.network.bridge.enable_ip_masquerade": "false" });
    const vols = doc.services.render.volumes as Array<{ source: string; target: string }>;
    for (const v of vols) expect(v.source.startsWith(path.join(root, "installations", INST) + path.sep)).toBe(true);
    expect(vols.map((v) => v.target)).toEqual(["/tmp", "/work"]);
  });

  it("refuses privileged mode", () => {
    expect(refusal(manifest({ privileged: true })).join("\n")).toMatch(/services\.1: "privileged": privileged mode is never allowed/);
  });

  it("refuses host networking, however it is spelled", () => {
    expect(refusal(manifest({ network_mode: "host" })).join("\n")).toMatch(/"network_mode": host networking is never allowed/);
    expect(refusal(manifest({ networks: ["host"] })).join("\n")).toMatch(/"networks": a service cannot choose its network/);
    expect(refusal(manifest({ ports: [{ container: 3045, host: 41001, bind: "0.0.0.0" }], health: undefined })).join("\n")).toMatch(
      /binds 0\.0\.0\.0; a port binds 127\.0\.0\.1 only/
    );
  });

  it("refuses host paths outside the installation folder", () => {
    const p1 = refusal(manifest({ volumes: ["/etc:/etc"] })).join("\n");
    expect(p1).toMatch(/"\/etc:\/etc" is a host path mount/);
    const p2 = refusal(manifest({ volumes: [{ name: "data", path: "/data", source: "/var/lib/docker" }] })).join("\n");
    expect(p2).toMatch(/"source" names a host path/);
    const p3 = refusal(manifest({ volumes: [{ name: "../../etc", path: "/data" }] })).join("\n");
    expect(p3).toMatch(/the volume name "\.\.\/\.\.\/etc" is not a slug/);
    const p4 = refusal(manifest({ volumes: [{ name: "data", path: "/etc" }] })).join("\n");
    expect(p4).toMatch(/a volume may not cover \/etc/);
  });

  it("refuses a planted symlink that would point a volume outside the installation folder", () => {
    const plan = planInstallation(manifest(), ctx());
    fs.mkdirSync(path.join(plan.dir, "volumes"), { recursive: true });
    fs.symlinkSync("/etc", path.join(plan.dir, "volumes", "work"));
    expect(() => writeInstallation(plan, { user: "1001:1001" })).toThrow(/not a plain folder/);
  });

  it("refuses any image not pinned by digest, or not pinned to the consented digest", () => {
    expect(refusal(manifest({ image: "synap-hyperframes-studio:0.9.12" })).join("\n")).toMatch(/is not pinned by digest/);
    expect(refusal(manifest({ image: "synap-hyperframes-studio:latest" })).join("\n")).toMatch(/is not pinned by digest/);
    expect(refusal(manifest({ image: `synap-hyperframes-studio@${D1}` })).join("\n")).toMatch(/is not the consented sha256:b{64}/);
    expect(refusal(manifest(), ctx({ digests: { render: D1 } })).join("\n")).toMatch(/studio: no consented digest/);
  });

  it("refuses declared egress unless the operator allowed it, and keys a manifest may not carry", () => {
    expect(refusal(manifest({ egress: ["fonts.googleapis.com"] })).join("\n")).toMatch(/cannot enforce an egress allow-list/);
    expect(() => planInstallation(manifest({ egress: ["api.example.com"] }), ctx({ allowDeclaredEgress: true }))).not.toThrow();
    const p = refusal(manifest({ cap_add: ["NET_ADMIN"], command: ["sh"], user: "0:0", devices: ["/dev/sda"] })).join("\n");
    for (const k of ["cap_add", "command", "user", "devices"]) expect(p).toContain(`"${k}"`);
  });

  it("reports every problem at once", () => {
    expect(refusal(manifest({ privileged: true, network_mode: "host", image: "x:latest" })).length).toBeGreaterThanOrEqual(3);
  });
});

// ── the job loop ─────────────────────────────────────────────────────────────

interface Calls {
  order: string[];
  reports: ReportBody[];
  finishes: Array<Omit<FinishBody, "leaseId">>;
}

function fakeHub(calls: Calls, opts: { heartbeat?: (n: number, phase: string) => Partial<HeartbeatAnswer> | Error } = {}): HostHub {
  let n = 0;
  return {
    async lease() {
      return null;
    },
    async heartbeat(job, phase) {
      n += 1;
      calls.order.push(`heartbeat:${phase}`);
      const r = opts.heartbeat?.(n, phase) ?? {};
      if (r instanceof Error) throw r;
      return { leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), stopRequested: false, logsRequested: false, ...r };
    },
    async report(_job, body) {
      calls.order.push("report");
      calls.reports.push(body as ReportBody);
      return {};
    },
    async finish(_job, body) {
      calls.order.push("finish");
      calls.finishes.push(body);
      return {};
    },
  };
}

interface FakeRuntime extends ContainerRuntime {
  downs: string[];
  ups: number;
}

function fakeRuntime(calls: Calls, opts: { present?: boolean; pullFails?: boolean; upFails?: boolean; state?: () => string; logs?: string } = {}): FakeRuntime {
  const rt: FakeRuntime = {
    downs: [],
    ups: 0,
    async imagePresent() {
      return opts.present ?? false;
    },
    async pull(ref) {
      calls.order.push(`pull:${ref.split("@")[0]}`);
      if (opts.pullFails) throw new Error("manifest unknown");
    },
    async up(plan: InstallationPlan) {
      calls.order.push("up");
      rt.ups += 1;
      if (opts.upFails) throw new Error("port is already allocated");
      expect(fs.existsSync(plan.composeFile)).toBe(true);
    },
    async down(project) {
      calls.order.push("down");
      rt.downs.push(project);
    },
    async ps(project): Promise<ContainerState[]> {
      const state = opts.state?.() ?? "running";
      return project.startsWith("synap-b")
        ? [{ service: "proxy", state, exitCode: null }]
        : [
            { service: "render", state, exitCode: null },
            { service: "studio", state, exitCode: null },
          ];
    },
    async logs() {
      return opts.logs ?? "studio | listening on 3045\n";
    },
    async projects() {
      return [];
    },
  };
  return rt;
}

function job(over: Partial<LeasedHostJob> = {}): LeasedHostJob {
  return {
    id: "99999999-8888-4777-8666-555555555555",
    kind: "install",
    leaseId: "11111111-2222-4333-8444-555555555555",
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    heartbeatIntervalSeconds: 30,
    attempt: 1,
    queuedAt: new Date().toISOString(),
    installation: {
      id: INST,
      capabilityKey: "hyperframes",
      capabilityVersion: "0.1.0",
      upstreamVersion: "0.9.12",
      manifest: manifest(),
      digests: { render: D1, studio: D2 },
    },
    bindingId: null,
    skillId: null,
    spec: {},
    parameters: {},
    ...over,
  };
}

const okFetch = async () => new Response("ok", { status: 200 });

function deps(calls: Calls, runtime: ContainerRuntime, hub: HostHub, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    hub,
    runtime,
    config: { installRoot: path.join(root, "installations"), user: "1001:1001", minFreeDiskMb: 1024 },
    log: () => {},
    fetchImpl: okFetch,
    freeDiskMb: () => 100_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    healthIntervalMs: 1,
    clocks: { healthMs: 200, startMs: 1000, pullMs: 1000 },
    secrets: [KEY],
    ...over,
  };
}

const newCalls = (): Calls => ({ order: [], reports: [], finishes: [] });
const instDir = () => path.join(root, "installations", INST);

describe("runJob: install", () => {
  it("pulls by digest in setup, starts only after a running heartbeat, reports health, finishes done", async () => {
    const calls = newCalls();
    const rt = fakeRuntime(calls);
    const out = await runJob(job(), deps(calls, rt, fakeHub(calls)));
    expect(out?.status).toBe("done");
    expect(calls.order).toEqual([
      "heartbeat:setup",
      "pull:synap-hyperframes-render",
      "pull:synap-hyperframes-studio:0.9.12",
      "heartbeat:running",
      "up",
      "report",
      "finish",
    ]);
    const health = calls.reports[0].health!;
    expect(Object.keys(health.services).sort()).toEqual(["render", "studio"]);
    expect(Object.values(health.services).every((s) => s.healthy)).toBe(true);
    expect(health.ports).toEqual([{ service: "studio", port: 41001, host: "127.0.0.1" }]);
    expect(health.versions).toEqual({ render: { digest: D1 }, studio: { digest: D2 } });
    expect(calls.reports[0].log).toBeUndefined(); // no log unless a person asked
    expect(fs.existsSync(path.join(instDir(), "compose.yaml"))).toBe(true);
  });

  it("keeps no pod key in its state files", async () => {
    const calls = newCalls();
    await runJob(job(), deps(calls, fakeRuntime(calls), fakeHub(calls)));
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(path.join(root, "installations"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(fs.readFileSync(f, "utf8")).not.toContain(KEY);
    const doc = YAML.parse(fs.readFileSync(path.join(instDir(), "compose.yaml"), "utf8"));
    expect(JSON.stringify(doc)).not.toMatch(/synap_|apiKey|Authorization/i);
  });

  it("sends a masked log only after a heartbeat asked for one", async () => {
    const calls = newCalls();
    const rt = fakeRuntime(calls, { logs: `studio | Authorization: Bearer abcdefghijklmnop\nstudio | key=${KEY}\n` });
    await runJob(job(), deps(calls, rt, fakeHub(calls, { heartbeat: () => ({ logsRequested: true }) })));
    const log = calls.reports[0].log!;
    expect(log.head).toContain("Bearer ***");
    expect(log.head).not.toContain(KEY);
    expect(log.head).not.toContain("abcdefghijklmnop");
  });
});

describe("runJob: cleanup runs on every failure path", () => {
  const cases: Array<{
    name: string;
    job?: Partial<LeasedHostJob>;
    rt?: Parameters<typeof fakeRuntime>[1];
    hub?: Parameters<typeof fakeHub>[1];
    over?: Partial<RunnerDeps>;
    status: FinishBody["status"];
    started: boolean;
  }> = [
    {
      name: "the manifest is refused",
      job: { installation: { ...job().installation, manifest: manifest({ privileged: true }) } },
      status: "failed",
      started: false,
    },
    { name: "the disk is short", over: { freeDiskMb: () => 2000 }, status: "failed", started: false },
    { name: "an image does not pull", rt: { present: false, pullFails: true }, status: "failed", started: false },
    { name: "the containers do not start", rt: { upFails: true }, status: "failed", started: true },
    { name: "a service never gets healthy", rt: { state: () => "restarting" }, status: "timeout", started: true },
    {
      name: "a person asks to stop",
      hub: { heartbeat: (n) => (n >= 2 ? { stopRequested: true } : {}) },
      status: "stopped",
      started: false,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: nothing of the installation is left, the finish says what was removed`, async () => {
      const calls = newCalls();
      const rt = fakeRuntime(calls, { present: true, ...c.rt });
      const out = await runJob(job(c.job), deps(calls, rt, fakeHub(calls, c.hub), c.over));
      expect(out?.status).toBe(c.status);
      expect(calls.order.at(-1)).toBe("finish");
      expect(calls.order).not.toContain("report");
      expect(fs.existsSync(instDir())).toBe(false);
      if (c.started) {
        expect(rt.downs).toEqual([projectName(INST)]);
        expect(out?.cleanedUp).toContain(`containers and network of ${projectName(INST)}`);
      } else {
        expect(rt.ups).toBe(0);
      }
      expect(out?.steps?.some((s) => !s.ok)).toBe(true);
    });
  }

  it("the runner stopping mid-job: cleaned up, finished infra", async () => {
    const calls = newCalls();
    const stop = new AbortController();
    const rt = fakeRuntime(calls, { present: true, state: () => (stop.abort(), "restarting") });
    const out = await runJob(job(), deps(calls, rt, fakeHub(calls), { signal: stop.signal }));
    expect(out?.status).toBe("infra");
    expect(out?.infraReason).toMatch(/stopped mid-job/);
    expect(rt.downs).toEqual([projectName(INST)]);
    expect(fs.existsSync(instDir())).toBe(false);
  });
});

describe("runJob: a lease that is lost or expires mid-job is never reported", () => {
  it("409 on a heartbeat during the health wait: cleaned up, no report, no finish", async () => {
    const calls = newCalls();
    const rt = fakeRuntime(calls, { present: true, state: () => "starting" });
    const out = await runJob(
      job(),
      deps(calls, rt, fakeHub(calls, { heartbeat: (n) => (n >= 3 ? new HostLeaseLostError("j", 409) : {}) }), { heartbeatMs: 10, clocks: { healthMs: 2000 } })
    );
    expect(out).toBeNull();
    expect(calls.order).not.toContain("report");
    expect(calls.order).not.toContain("finish");
    expect(rt.downs).toEqual([projectName(INST)]);
    expect(fs.existsSync(instDir())).toBe(false);
  });

  it("the lease runs out unrenewed (heartbeats failing) before the report: cleaned up, no report, no finish", async () => {
    const calls = newCalls();
    let t = Date.now();
    const rt = fakeRuntime(calls, { present: true });
    const out = await runJob(
      job({ leaseExpiresAt: new Date(t + 60_000).toISOString() }),
      deps(calls, rt, fakeHub(calls, { heartbeat: (n) => (n >= 2 ? new Error("ECONNRESET") : { leaseExpiresAt: new Date(t + 60_000).toISOString() }) }), {
        now: () => t,
        // Each health wait moves the clock 2 minutes: the lease (60 s) expires while the services settle.
        sleep: async () => {
          t += 120_000;
        },
        fetchImpl: async () => new Response("", { status: 503 }),
        clocks: { healthMs: 300_000 },
      })
    );
    expect(out).toBeNull();
    expect(calls.order).not.toContain("report");
    expect(calls.order).not.toContain("finish");
    expect(fs.existsSync(instDir())).toBe(false);
  });

  it("the lease is already gone at the first heartbeat: nothing is started", async () => {
    const calls = newCalls();
    const rt = fakeRuntime(calls);
    const out = await runJob(job(), deps(calls, rt, fakeHub(calls, { heartbeat: () => new HostLeaseLostError("j", 404) })));
    expect(out).toBeNull();
    expect(calls.order).toEqual(["heartbeat:setup"]);
    expect(fs.existsSync(instDir())).toBe(false);
  });
});

describe("runJob: update, remove, verb", () => {
  async function installed(calls: Calls) {
    await runJob(job(), deps(calls, fakeRuntime(calls, { present: true }), fakeHub(calls)));
    return fs.readFileSync(path.join(instDir(), "compose.yaml"), "utf8");
  }

  it("an update whose new version is not healthy rolls back to the previous compose and fails", async () => {
    const before = await installed(newCalls());
    const calls = newCalls();
    const D3 = `sha256:${"c".repeat(64)}`;
    const next = manifest({ image: `synap-hyperframes-studio:0.9.13@${D3}` });
    const rt = fakeRuntime(calls, { present: true });
    const out = await runJob(
      job({ kind: "update", installation: { ...job().installation, manifest: next, digests: { render: D1, studio: D3 } } }),
      deps(calls, rt, fakeHub(calls), { fetchImpl: async () => new Response("", { status: 500 }) })
    );
    expect(out?.status).toBe("failed");
    expect(fs.readFileSync(path.join(instDir(), "compose.yaml"), "utf8")).toBe(before);
    expect(rt.ups).toBe(2); // the new version, then the rollback
    expect(out?.steps?.map((s) => s.name)).toContain("roll back to the previous version");
    expect(rt.downs).toEqual([]); // the old version keeps running
  });

  it("a remove stops everything and keeps the data folder unless told otherwise", async () => {
    await installed(newCalls());
    const calls = newCalls();
    const rt = fakeRuntime(calls);
    const out = await runJob(job({ kind: "remove" }), deps(calls, rt, fakeHub(calls)));
    expect(out?.status).toBe("done");
    expect(rt.downs).toEqual([projectName(INST)]);
    expect(fs.existsSync(path.join(instDir(), "compose.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(instDir(), "volumes", "work"))).toBe(true);
    expect(fs.existsSync(path.join(instDir(), "scratch"))).toBe(false);

    const calls2 = newCalls();
    await runJob(job({ kind: "remove", spec: { keepData: false } }), deps(calls2, fakeRuntime(calls2), fakeHub(calls2)));
    expect(fs.existsSync(instDir())).toBe(false);
  });

  it("a hosted verb is answered failed with the reason (U8 runs them)", async () => {
    const calls = newCalls();
    const out = await runJob(job({ kind: "verb" }), deps(calls, fakeRuntime(calls), fakeHub(calls)));
    expect(out?.status).toBe("failed");
    expect(out?.steps?.[0].detail).toMatch(/does not run hosted verbs yet/);
  });

  it("serve --once leases at most one job", async () => {
    const calls = newCalls();
    let leases = 0;
    const hub = { ...fakeHub(calls), lease: async () => (leases++ === 0 ? job({ kind: "verb" }) : null) };
    await serveHost(deps(calls, fakeRuntime(calls), hub), { idleMs: 1, errorWaitMs: 1, once: true });
    expect(leases).toBe(1);
    expect(calls.finishes).toHaveLength(1);
  });
});

// ── provider ops ─────────────────────────────────────────────────────────────

describe("provider ops", () => {
  const TS = "100.64.0.5";
  const proxyManifest = {
    services: [{ id: "proxy", image: `synap-tailnet-proxy@${D1}`, limits: { cpus: 0.5, memoryMb: 128, diskMb: 256 } }],
  };
  const opJob = (op: string, input: Record<string, unknown> = {}) =>
    job({
      kind: "provider_op",
      bindingId: BIND,
      installation: { id: "22222222-3333-4444-8555-666666666666", capabilityKey: "tailnet-expose", capabilityVersion: "0.1.0", upstreamVersion: null, manifest: proxyManifest, digests: { proxy: D1 } },
      spec: { provider: "tailnet-expose", op, input: { installationId: INST, needKey: "studio_url", service: "studio", source: { kind: "local_port", port: 41001 }, ...input } },
    });

  it("create publishes the proxy on the tailnet address only, reaching the studio over its installation's bridge", async () => {
    const calls = newCalls();
    await runJob(job(), deps(calls, fakeRuntime(calls, { present: true }), fakeHub(calls)));
    const j = opJob("create");
    const plan = planProviderOp(j, parseProviderOp(j), { installRoot: path.join(root, "installations"), user: "1001:1001", tailnetIp: TS, tailnetPorts: { from: 3045, to: 3049 } });
    const svc = (plan.document.services as Record<string, Record<string, unknown>>).proxy;
    const port = listenPortFor(BIND, { from: 3045, to: 3049 });
    expect(svc.ports).toEqual([`${TS}:${port}:8080/tcp`]);
    expect(svc).not.toHaveProperty("network_mode");
    expect((svc.environment as Record<string, string>).PROXY_UPSTREAM).toBe(`${projectName(INST)}-studio:3045`);
    expect(plan.url).toBe(`http://${TS}:${port}`);

    const calls2 = newCalls();
    const out = await runJob(j, deps(calls2, fakeRuntime(calls2, { present: true }), fakeHub(calls2), {
      config: { installRoot: path.join(root, "installations"), user: "1001:1001", minFreeDiskMb: 1024, tailnetIp: TS, tailnetPorts: { from: 3045, to: 3049 } },
    }));
    expect(out?.status).toBe("done");
    expect(out?.output).toMatchObject({ state: "live", url: `http://${TS}:${port}`, authApplied: "tailnet", public: false });
  });

  it("refuses without a tailnet address, or with one outside 100.64.0.0/10", async () => {
    const calls = newCalls();
    await runJob(job(), deps(calls, fakeRuntime(calls, { present: true }), fakeHub(calls)));
    const j = opJob("create");
    const env = { installRoot: path.join(root, "installations"), user: "1001:1001" };
    expect(() => planProviderOp(j, parseProviderOp(j), env)).toThrow(ProviderOpRefusal);
    expect(() => planProviderOp(j, parseProviderOp(j), { ...env, tailnetIp: "0.0.0.0" })).toThrow(/tailnet IPv4/);
    expect(isTailnetIPv4("100.64.0.5")).toBe(true);
    expect(isTailnetIPv4("10.10.0.60")).toBe(false);
    expect(isTailnetIPv4("100.128.0.1")).toBe(false);
  });

  it("a failed create removes what it started and says failed in the contract output", async () => {
    const calls = newCalls();
    await runJob(job(), deps(calls, fakeRuntime(calls, { present: true }), fakeHub(calls)));
    const calls2 = newCalls();
    const rt = fakeRuntime(calls2, { present: true });
    const out = await runJob(opJob("create"), deps(calls2, rt, fakeHub(calls2), {
      config: { installRoot: path.join(root, "installations"), user: "1001:1001", minFreeDiskMb: 1024, tailnetIp: TS },
      fetchImpl: async () => new Response("", { status: 502 }),
    }));
    expect(out?.status).toBe("timeout");
    expect(out?.output).toMatchObject({ state: "failed", url: null });
    expect(rt.downs).toEqual([`synap-b${BIND.replace(/-/g, "").slice(0, 11)}`]);
    expect(fs.existsSync(path.join(root, "installations", "bindings", BIND))).toBe(false);
  });

  it("refuses an unknown provider or a binding-less op", () => {
    expect(() => parseProviderOp(job({ kind: "provider_op", bindingId: BIND, spec: { provider: "ngrok", op: "create", input: {} } }))).toThrow(/no computer-side op/);
    expect(() => parseProviderOp({ ...opJob("create"), bindingId: null })).toThrow(/needs the binding/);
  });
});

// ── logs and wire ────────────────────────────────────────────────────────────

describe("logs", () => {
  it("masks known secrets and credential shapes, and caps each end", () => {
    expect(maskSecrets("token=abc123def456 and SECRET_VALUE", ["SECRET_VALUE"])).toBe("token=*** and ***");
    const big = "x".repeat(3 * HOST_LOG_CAP);
    const log = toHostLog(big);
    expect(Buffer.byteLength(log.head!, "utf8")).toBeLessThanOrEqual(HOST_LOG_CAP);
    expect(Buffer.byteLength(log.tail!, "utf8")).toBeLessThanOrEqual(HOST_LOG_CAP);
    expect(log.truncated).toBe(true);
    expect(log.totalBytes).toBe(3 * HOST_LOG_CAP);
  });
});

describe("wire", () => {
  it("calls the host-job routes with the computer's key and turns 404/409 into a lost lease", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    let status = 200;
    const hub = createHostHub({ podUrl: "https://pod.example/", apiKey: "k1" }, async (url, init) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ job: null, leaseExpiresAt: new Date().toISOString(), stopRequested: false, logsRequested: false }), { status });
    });
    expect(await hub.lease()).toBeNull();
    await hub.heartbeat(job(), "running");
    expect(seen.map((s) => s.url)).toEqual([
      "https://pod.example/api/hub/host-jobs/lease",
      `https://pod.example/api/hub/host-jobs/${job().id}/heartbeat`,
    ]);
    expect(seen[1]).toMatchObject({ auth: "Bearer k1", body: { leaseId: job().leaseId, phase: "running" } });
    status = 409;
    await expect(hub.finish(job(), { status: "done" })).rejects.toBeInstanceOf(HostLeaseLostError);
  });
});
