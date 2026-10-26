/**
 * The run box provisioner (`synap box serve`): egress policy and proxy, the
 * evidence bundle, the job server the box talks to, and the lease loop — all
 * with fakes (no Proxmox, no pod). The host and pod halves are dogfooded on
 * the real host; see my server docs/RUNBOX.md.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEgressProxy,
  decideByName,
  decideEgress,
  hostMatches,
  isForbiddenAddress,
  type BlockedEgress,
  type EgressPolicy,
} from "../src/lib/box/egress.js";
import { assembleFinish, deriveStatus, LogCapture, WIRE } from "../src/lib/box/evidence.js";
import { BoxRegistry, createJobServer, MAX_OUT_FILES, parseReport, safeOutPath } from "../src/lib/box/job-server.js";
import {
  boxesOf,
  boxIpFor,
  createProxmoxApi,
  thinMetaPct,
  type BoxBackend,
  type BoxHostConfig,
} from "../src/lib/box/proxmox.js";
import { checkGuards, clampLimits, PHASE0_CAPS, reap, runOne, serve, type ProvisionerDeps } from "../src/lib/box/provisioner.js";
import {
  createBoxHub,
  LeaseLostError,
  WorkspaceRequiredError,
  type BoxHub,
  type FinishBody,
  type LeasedRun,
} from "../src/lib/box/wire.js";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    closers.push(() => server.close());
  });
}

function leased(over: Partial<LeasedRun["script"]> = {}, run: Partial<LeasedRun> = {}): LeasedRun {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    leaseId: "lease-1",
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    heartbeatIntervalSeconds: 30,
    queuedAt: new Date().toISOString(),
    attempt: 1,
    parameters: { csv: "a,b" },
    script: {
      skillId: "skill-1",
      name: "chart_csv",
      language: "python",
      entrypoint: "main.py",
      code: "print('hi')",
      packages: [{ name: "pandas", version: "2.2.3" }],
      hosts: ["api.example.com"],
      limits: { wallSeconds: 900, cpus: 2, memoryMb: 2048, diskMb: 8192, outMb: 1 },
      ...over,
    },
    ...run,
  };
}

// ─── egress ──────────────────────────────────────────────────────────────────

describe("isForbiddenAddress", () => {
  it.each([
    ["10.10.0.10", "the pod on vmbr1"],
    ["10.20.0.1", "the provisioner on the box bridge"],
    ["192.168.1.201", "the Proxmox host on the LAN"],
    ["172.16.5.4", "RFC1918"],
    ["169.254.169.254", "cloud metadata"],
    ["100.64.0.4", "the tailnet (CGNAT)"],
    ["127.0.0.1", "loopback"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
    ["::1", "v6 loopback"],
    ["::", "v6 unspecified"],
    ["::ffff:10.10.0.10", "v4-mapped pod"],
    ["::ffff:a0a:a", "v4-mapped pod, hex form"],
    ["64:ff9b::a0a:a", "NAT64 of the pod"],
    ["fe80::1", "v6 link-local"],
    ["fd12:3456::1", "v6 unique local"],
    ["::10.10.0.10", "IPv4-compatible pod (::/96)"],
    ["2002:a0a:a::1", "6to4 of the pod"],
    ["2001:0:4136:e378::1", "Teredo"],
    ["2001:db8::1", "documentation"],
    ["not-an-ip", "unparsable fails closed"],
  ])("refuses %s (%s)", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "151.101.0.223", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1"])("allows public %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
});

describe("hostMatches", () => {
  it("matches exactly, case and trailing dot ignored", () => {
    expect(hostMatches("API.Example.com.", ["api.example.com"])).toBe(true);
  });
  it("a wildcard is a strict subdomain: never the apex, never a suffix", () => {
    expect(hostMatches("a.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatches("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("evilexample.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("example.com.evil.io", ["example.com"])).toBe(false);
  });
});

describe("decideByName", () => {
  const setup: EgressPolicy = { phase: "setup", runHosts: ["api.example.com"] };
  const runP: EgressPolicy = { phase: "run", runHosts: ["api.example.com", "db.example.com:5432"] };

  it("setup reaches the registries only, never the declared hosts", () => {
    expect(decideByName("pypi.org", 443, setup).allow).toBe(true);
    expect(decideByName("registry.npmjs.org", 443, setup).allow).toBe(true);
    expect(decideByName("api.example.com", 443, setup).allow).toBe(false);
  });

  it("run reaches the declared hosts only, never the registries", () => {
    expect(decideByName("api.example.com", 443, runP).allow).toBe(true);
    expect(decideByName("pypi.org", 443, runP).allow).toBe(false);
    expect(decideByName("other.io", 443, runP)).toMatchObject({ allow: false, reason: /not a host this script declared/ });
  });

  it("a bare host opens 80/443 only; host:port opens that port only", () => {
    expect(decideByName("api.example.com", 22, runP).allow).toBe(false);
    expect(decideByName("db.example.com", 5432, runP).allow).toBe(true);
    expect(decideByName("db.example.com", 443, runP).allow).toBe(false);
  });

  it("an address literal is never allowed, even one that looks public", () => {
    expect(decideByName("8.8.8.8", 443, { phase: "run", runHosts: ["8.8.8.8"] }).allow).toBe(false);
    expect(decideByName("[::1]", 443, runP).allow).toBe(false);
  });
});

describe("decideEgress (resolved-address check)", () => {
  const policy: EgressPolicy = { phase: "run", runHosts: ["api.example.com"] };

  it("a declared host that resolves to the pod is refused (DNS rebinding)", async () => {
    const d = await decideEgress("api.example.com", 443, policy, async () => ["93.184.216.34", "10.10.0.10"]);
    expect(d).toMatchObject({ allow: false, reason: /internal address \(10\.10\.0\.10\)/ });
  });

  it("returns the checked address to connect to, so nothing re-resolves", async () => {
    expect(await decideEgress("api.example.com", 443, policy, async () => ["93.184.216.34"])).toEqual({
      allow: true,
      address: "93.184.216.34",
    });
  });

  it("a failed lookup is a refusal, not a pass", async () => {
    const d = await decideEgress("api.example.com", 443, policy, async () => {
      throw new Error("ENOTFOUND");
    });
    expect(d).toMatchObject({ allow: false, reason: /could not resolve/ });
  });
});

describe("the egress proxy", () => {
  async function setupProxy(policy: EgressPolicy | null, resolved: string[]) {
    const upstream = net.createServer((s) => s.end("upstream-hello"));
    const upPort = await listen(upstream);
    const blocks: BlockedEgress[] = [];
    const connected: string[] = [];
    const proxy = createEgressProxy({
      policyFor: () => policy,
      onBlock: (_ip, b) => blocks.push(b),
      resolve: async () => resolved,
      connect: (address) => {
        connected.push(address);
        return net.connect({ host: "127.0.0.1", port: upPort });
      },
    });
    const port = await listen(proxy);
    return { port, blocks, connected };
  }

  function connectVia(port: number, target: string): Promise<string> {
    return new Promise((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let data = "";
      s.on("data", (d) => (data += d.toString()));
      s.on("end", () => resolve(data));
      s.on("error", () => resolve(data));
    });
  }

  it("tunnels a declared host to the address it checked", async () => {
    const p = await setupProxy({ phase: "run", runHosts: ["api.example.com"] }, ["93.184.216.34"]);
    const out = await connectVia(p.port, "api.example.com:443");
    expect(out).toMatch(/^HTTP\/1\.1 200/);
    expect(out).toContain("upstream-hello");
    expect(p.connected).toEqual(["93.184.216.34"]);
    expect(p.blocks).toEqual([]);
  });

  it("refuses an undeclared host and records the block", async () => {
    const p = await setupProxy({ phase: "run", runHosts: ["api.example.com"] }, ["93.184.216.34"]);
    const out = await connectVia(p.port, "evil.io:443");
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(p.connected).toEqual([]);
    expect(p.blocks).toMatchObject([{ host: "evil.io", port: 443, phase: "run", reason: /not a host this script declared/ }]);
  });

  it("refuses the pod even by a declared name, and connects nowhere", async () => {
    const p = await setupProxy({ phase: "run", runHosts: ["api.example.com"] }, ["10.10.0.10"]);
    const out = await connectVia(p.port, "api.example.com:443");
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(p.connected).toEqual([]);
    expect(p.blocks[0].reason).toMatch(/internal address/);
  });

  it("answers nothing to an address that is not a running box", async () => {
    const p = await setupProxy(null, ["93.184.216.34"]);
    const out = await connectVia(p.port, "api.example.com:443");
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(p.connected).toEqual([]);
  });
});

// ─── evidence ────────────────────────────────────────────────────────────────

describe("LogCapture", () => {
  it("keeps everything when it fits", () => {
    const l = new LogCapture(8, 8);
    l.append("hello ");
    l.append("world");
    expect(l.snapshot()).toEqual({ head: "hello wo", tail: "rld", totalBytes: 11, truncated: false });
  });

  it("keeps head + tail and says bytes were dropped", () => {
    const l = new LogCapture(4, 4);
    for (const c of ["AAAA", "BBBB", "CCCC", "DD"]) l.append(c);
    expect(l.snapshot()).toEqual({ head: "AAAA", tail: "CCDD", totalBytes: 14, truncated: true });
  });
});

describe("deriveStatus", () => {
  it("a Stop beats the wall clock, the wall clock beats a late exit code", () => {
    expect(deriveStatus({ exitCode: 0, timedOut: true, stopped: true })).toEqual({ status: "stopped" });
    expect(deriveStatus({ exitCode: 0, timedOut: true, stopped: false })).toEqual({ status: "timeout" });
  });
  it("a wall-clock kill is timeout, never INFRA", () => {
    expect(deriveStatus({ exitCode: null, timedOut: true, stopped: false })).toEqual({ status: "timeout" });
  });
  it("no exit code is INFRA with a reason, never a plain failure", () => {
    expect(deriveStatus({ exitCode: null, timedOut: false, stopped: false })).toMatchObject({
      status: "infra",
      infraReason: expect.any(String),
    });
    expect(deriveStatus({ exitCode: null, timedOut: false, stopped: false, infraReason: "clone failed: x" })).toEqual({
      status: "infra",
      infraReason: "clone failed: x",
    });
  });
  it("exit 0 is done, anything else is failed", () => {
    expect(deriveStatus({ exitCode: 0, timedOut: false, stopped: false })).toEqual({ status: "done" });
    expect(deriveStatus({ exitCode: 2, timedOut: false, stopped: false })).toEqual({ status: "failed" });
  });
});

describe("assembleFinish", () => {
  it("builds the v2 (flat) finish body", () => {
    const log = new LogCapture();
    log.append("ok\n");
    const file = { path: "chart.png", size: 3, sha256: "h", uploadToken: "sau1.x", title: "chart.png" };
    const body = assembleFinish({
      leaseId: "L",
      outcome: { exitCode: 0, timedOut: false, stopped: false },
      startedAt: 1000,
      finishedAt: 4500,
      log,
      blockedEgress: [],
      installedPackages: [{ name: "pandas", version: "2.2.3", manager: "pip" }],
      files: [file],
    });
    expect(body).toEqual({
      leaseId: "L",
      status: "done",
      exitCode: 0,
      durationMs: 3500,
      log: { head: "ok\n", tail: "", totalBytes: 3, truncated: false },
      files: [file],
      blockedEgress: [],
      installedPackages: [{ name: "pandas", version: "2.2.3", manager: "pip" }],
    });
  });
});

describe("the finish body fits the pod's schema (a 400 would lose the whole evidence)", () => {
  it("caps the lists and cuts long strings, saying so in the log", () => {
    const log = new LogCapture();
    const blocked = Array.from({ length: 600 }, (_, i) => ({ host: `h${i}.io`, port: 443, phase: "run" as const, reason: "x", at: "t" }));
    blocked[0] = { ...blocked[0], host: "a".repeat(400), reason: "r".repeat(900) };
    const body = assembleFinish({
      leaseId: "L",
      outcome: { exitCode: null, timedOut: false, stopped: false, infraReason: "e".repeat(2000) },
      startedAt: 0,
      finishedAt: 1.6,
      log,
      blockedEgress: blocked,
      installedPackages: [
        { name: "ok", version: "1", manager: "pip" },
        { name: "noversion", version: "", manager: "npm" },
        { name: "long", version: "v".repeat(100), manager: "pip" },
      ],
      files: [{ path: "p".repeat(10), size: 1, sha256: "h", title: "t".repeat(300) }],
    });
    expect(body.blockedEgress).toHaveLength(WIRE.maxBlocked);
    expect(body.blockedEgress[0].host.length).toBeLessThanOrEqual(WIRE.hostChars);
    expect(body.blockedEgress[0].reason.length).toBeLessThanOrEqual(WIRE.reasonChars);
    expect(body.infraReason!.length).toBeLessThanOrEqual(WIRE.infraReasonChars);
    expect(body.installedPackages.map((p) => p.name)).toEqual(["ok", "long"]);
    expect(body.installedPackages[1].version.length).toBeLessThanOrEqual(WIRE.packageVersionChars);
    expect(body.files[0].title!.length).toBeLessThanOrEqual(WIRE.titleChars);
    expect(Number.isInteger(body.durationMs)).toBe(true);
    expect(body.log.head).toMatch(/100 more blocked connections not listed/);
  });
});

describe("clampLimits", () => {
  it("keeps limits inside the caps untouched", () => {
    expect(clampLimits({ wallSeconds: 900, cpus: 2, memoryMb: 2048, diskMb: 8192, outMb: 200 })).toEqual({
      limits: { wallSeconds: 900, cpus: 2, memoryMb: 2048, diskMb: 8192, outMb: 200 },
      clamped: [],
    });
  });
  it("a missing or non-positive limit takes the cap, never 0 or unlimited", () => {
    const { limits } = clampLimits({ wallSeconds: 0, cpus: Number.NaN, memoryMb: -1, diskMb: 8192, outMb: 200 });
    expect(limits).toEqual(PHASE0_CAPS);
  });
});

// ─── job server ──────────────────────────────────────────────────────────────

describe("safeOutPath", () => {
  it.each(["/out/chart.png", "/out/plots/a%20b.png"])("accepts %s", (p) => {
    expect(safeOutPath(p)).not.toBeNull();
  });
  it.each(["/out/../etc/passwd", "/out/%2e%2e/x", "/out/a/%2F/b", "/out/", "/out/a//b", "/out/a%00b"])("refuses %s", (p) => {
    expect(safeOutPath(p)).toBeNull();
  });
});

describe("parseReport", () => {
  it("no integer exit code reads as null (INFRA), never as a failure code", () => {
    expect(parseReport({ exitCode: "0" }).exitCode).toBeNull();
    expect(parseReport({}).exitCode).toBeNull();
    expect(parseReport({ exitCode: -9 }).exitCode).toBe(-9);
  });
  it("drops a package with no version (the pod refuses an empty one)", () => {
    expect(parseReport({ exitCode: 0, installedPackages: [{ name: "a", version: "" }, { name: "b", version: "1" }] }).installedPackages).toEqual([
      { name: "b", version: "1", manager: "pip" },
    ]);
  });
});

describe("the job server", () => {
  function staging() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-staging-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function req(port: number, method: string, p: string, body?: string | Buffer): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path: p }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on("error", (e) => (e.message.includes("ECONNRESET") || e.message.includes("EPIPE") ? resolve({ status: 413, body: "" }) : reject(e)));
      if (body !== undefined) r.write(body);
      r.end();
    });
  }

  it("answers only the address a run was given to", async () => {
    const reg = new BoxRegistry(staging());
    const port = await listen(createJobServer(reg));
    expect((await req(port, "GET", "/job")).status).toBe(403);
    reg.register("127.0.0.1", leased());
    const job = JSON.parse((await req(port, "GET", "/job")).body);
    expect(job).toMatchObject({ language: "python", entrypoint: "main.py", code: "print('hi')", parameters: { csv: "a,b" }, wallSeconds: 900 });
    expect(job).not.toHaveProperty("leaseId");
  });

  it("moves setup → run once, narrowing egress, and tells the provisioner", async () => {
    const reg = new BoxRegistry(staging());
    const seen: string[] = [];
    reg.onEvent = (r, e) => seen.push(`${r.id.slice(0, 4)}:${e}`);
    const port = await listen(createJobServer(reg));
    reg.register("127.0.0.1", leased());
    expect(reg.policyFor("127.0.0.1")?.phase).toBe("setup");
    await req(port, "POST", "/phase", JSON.stringify({ phase: "run" }));
    await req(port, "POST", "/phase", JSON.stringify({ phase: "run" }));
    expect(reg.policyFor("127.0.0.1")).toEqual({ phase: "run", runHosts: ["api.example.com"] });
    expect(seen).toEqual(["1111:run"]);
    expect((await req(port, "POST", "/phase", JSON.stringify({ phase: "setup" }))).status).toBe(400);
  });

  it("stages /out files under the size and count caps", async () => {
    const reg = new BoxRegistry(staging());
    const port = await listen(createJobServer(reg));
    const box = reg.register("127.0.0.1", leased({ limits: { wallSeconds: 900, cpus: 2, memoryMb: 2048, diskMb: 8192, outMb: 1 } }));
    expect((await req(port, "PUT", "/out/chart.png", "PNGDATA")).status).toBe(201);
    expect(box.outFiles).toMatchObject([{ path: "chart.png", size: 7 }]);
    expect(fs.readFileSync(path.join(box.outDir, "chart.png"), "utf8")).toBe("PNGDATA");
    expect((await req(port, "PUT", "/out/big.bin", Buffer.alloc(1024 * 1024 + 1))).status).toBe(413);
    expect(fs.existsSync(path.join(box.outDir, "big.bin"))).toBe(false);
    expect((await req(port, "PUT", "/out/..%2Fescape", "x")).status).toBe(400);
    for (let i = box.outFiles.length; i < MAX_OUT_FILES; i++) await req(port, "PUT", `/out/f${i}.txt`, "x");
    expect((await req(port, "PUT", "/out/one-too-many.txt", "x")).status).toBe(413);
  });

  it("collects the log and resolves done with the report", async () => {
    const reg = new BoxRegistry(staging());
    const port = await listen(createJobServer(reg));
    const box = reg.register("127.0.0.1", leased());
    await req(port, "POST", "/log", "line 1\n");
    await req(port, "POST", "/done", JSON.stringify({ exitCode: 3, installedPackages: [{ name: "pandas", version: "2.2.3", manager: "pip" }] }));
    expect(await box.done).toEqual({ exitCode: 3, installedPackages: [{ name: "pandas", version: "2.2.3", manager: "pip" }] });
    expect(box.log.snapshot().head).toBe("line 1\n");
  });

  it("unregister drops the staged files", () => {
    const reg = new BoxRegistry(staging());
    const box = reg.register("127.0.0.1", leased());
    fs.writeFileSync(path.join(box.outDir, "x"), "x");
    reg.unregister("127.0.0.1");
    expect(fs.existsSync(box.outDir)).toBe(false);
    expect(reg.policyFor("127.0.0.1")).toBeNull();
  });
});

// ─── proxmox backend helpers ─────────────────────────────────────────────────

describe("the box backend's readings", () => {
  const cfg: BoxHostConfig = {
    templateVmid: 900,
    pool: "synap-box",
    storage: "local-lvm",
    bridge: "vmbr2",
    subnetPrefix: "10.20.0",
    vmidMin: 901,
    vmidMax: 904,
    cpuunits: 25,
  };
  it("gives each slot its own bridge address from .10", () => {
    expect(boxIpFor(cfg, 901)).toBe("10.20.0.10");
    expect(boxIpFor(cfg, 903)).toBe("10.20.0.12");
  });
  it("the reaper sees only tagged boxes of the pool and range, never the template or another guest", () => {
    const guests = [
      { vmid: 901, type: "lxc", name: "box-a", pool: "synap-box", tags: "run-1;synap-box" },
      { vmid: 900, type: "lxc", name: "tpl", pool: "synap-box", tags: "synap-box", template: 1 },
      { vmid: 111, type: "lxc", name: "box-provisioner", pool: "synap-box", tags: "synap-box" },
      { vmid: 902, type: "lxc", name: "untagged", pool: "synap-box", tags: "synap-box-template" },
      { vmid: 903, type: "lxc", name: "other-pool", pool: "prod", tags: "synap-box" },
      { vmid: 904, type: "qemu", name: "vm", pool: "synap-box", tags: "synap-box" },
      { vmid: 101, type: "lxc", name: "synap-personal" },
    ];
    expect(boxesOf(cfg, guests)).toEqual([{ vmid: 901, name: "box-a" }]);
  });
  it("thin pool metadata: read from the listed pool; a pool not listed is an error, never 0%", () => {
    const pools = [{ lv: "data", vg: "pve", metadata_size: 1000, metadata_used: 150 }];
    expect(thinMetaPct("pve/data", pools)).toBe(15);
    expect(() => thinMetaPct("pve/other", pools)).toThrow(/not found/);
  });
});

describe("the Proxmox API client's TLS", () => {
  // The founder's host cert names `main`, not 10.10.0.1: reproduce that with a
  // CA and a leaf for DNS:main only, served on 127.0.0.1.
  function pki() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-tls-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const f = (n: string) => path.join(dir, n);
    const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
    ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f("ca.key"), "-out", f("ca.pem"), "-days", "2", "-subj", "/CN=test PVE root");
    ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", f("leaf.key"), "-out", f("leaf.csr"), "-subj", "/CN=main");
    fs.writeFileSync(f("ext"), "subjectAltName=DNS:main\n");
    ssl("x509", "-req", "-in", f("leaf.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-out", f("leaf.pem"), "-days", "2", "-extfile", f("ext"));
    return { ca: fs.readFileSync(f("ca.pem"), "utf8"), key: fs.readFileSync(f("leaf.key")), cert: fs.readFileSync(f("leaf.pem")) };
  }

  async function serve(p: ReturnType<typeof pki>) {
    const server = https.createServer({ key: p.key, cert: p.cert }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { ok: true } }));
    });
    closers.push(() => server.closeAllConnections());
    return listen(server as unknown as http.Server);
  }

  it("verifies the pinned CA against the cert's name when the endpoint is an address it does not list", async () => {
    const p = pki();
    const port = await serve(p);
    const api = createProxmoxApi({ endpoint: `https://127.0.0.1:${port}`, token: "t", ca: p.ca, node: "main", serverName: "main" });
    expect(await api.get("/version")).toEqual({ ok: true });
  });

  it("without the server name the address is refused (never rejectUnauthorized: false)", async () => {
    const p = pki();
    const port = await serve(p);
    const api = createProxmoxApi({ endpoint: `https://127.0.0.1:${port}`, token: "t", ca: p.ca, node: "main" });
    await expect(api.get("/version")).rejects.toThrow(/IP: 127\.0\.0\.1 is not in the cert's list|altnames/);
  });
});

// ─── the lease loop ──────────────────────────────────────────────────────────

class FakeBackend implements BoxBackend {
  created: string[] = [];
  destroyed: number[] = [];
  boxes = new Map<number, string>();
  failCreate = false;
  onCreate: (ip: string) => void = () => {};
  reading: { memAvailableMb: number; storageUsedPct: number; metaUsedPct: number | null } = {
    memAvailableMb: 14000,
    storageUsedPct: 69,
    metaUsedPct: 15,
  };
  async readHost() {
    return this.reading;
  }
  async create(runId: string) {
    if (this.failCreate) throw new Error("storage full");
    this.created.push(runId);
    this.boxes.set(901, `box-${runId.slice(0, 8)}`);
    setTimeout(() => this.onCreate("127.0.0.1"), 0);
    return { vmid: 901, ip: "127.0.0.1" };
  }
  async destroy(vmid: number) {
    this.destroyed.push(vmid);
    this.boxes.delete(vmid);
  }
  async list() {
    return [...this.boxes].map(([vmid, name]) => ({ vmid, name }));
  }
}

class FakeHub implements BoxHub {
  beats: Array<"setup" | "running"> = [];
  finished: FinishBody[] = [];
  uploads: string[] = [];
  leases: Array<LeasedRun | null> = [];
  leaseCalls = 0;
  heartbeatImpl: (n: number) => { leaseExpiresAt: string; stopRequested: boolean } = () => ({
    leaseExpiresAt: "x",
    stopRequested: false,
  });
  uploadImpl: (filename: string) => string = (f) => `tok-${f}`;
  async lease() {
    this.leaseCalls++;
    return this.leases.shift() ?? null;
  }
  async heartbeat(_run: LeasedRun, phase: "setup" | "running") {
    this.beats.push(phase);
    return this.heartbeatImpl(this.beats.length);
  }
  async upload(_run: LeasedRun, file: { filename: string }) {
    this.uploads.push(file.filename);
    return this.uploadImpl(file.filename);
  }
  async finish(_run: LeasedRun, body: FinishBody) {
    this.finished.push(body);
    return {};
  }
}

function deps(hub: FakeHub, backend: FakeBackend): ProvisionerDeps & { registry: BoxRegistry; lines: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-staging-"));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  return { hub, backend, registry: new BoxRegistry(dir), log: (l) => lines.push(l), lines };
}

describe("runOne", () => {
  it("a run that exits 0: phase heartbeat, files uploaded, box destroyed, finish done", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const d = deps(hub, backend);
    backend.onCreate = (ip) => {
      const box = d.registry.get(ip)!;
      box.log.append("plotting\n");
      fs.writeFileSync(path.join(box.outDir, "chart.png"), "PNG");
      box.outFiles.push({ path: "chart.png", size: 3, sha256: "h" });
      d.registry.enterRunPhase(ip);
      (box as unknown as { finish: (r: unknown) => void }).finish({ exitCode: 0, installedPackages: [] });
    };
    const body = await runOne(leased(), d);
    expect(body?.status).toBe("done");
    expect(body?.files).toEqual([{ path: "chart.png", size: 3, sha256: "h", uploadToken: "tok-chart.png", title: "chart.png" }]);
    expect(body?.log.head).toBe("plotting\n");
    expect(hub.beats.slice(0, 2)).toEqual(["setup", "running"]);
    expect(backend.destroyed).toEqual([901]);
    expect(hub.finished).toHaveLength(1);
    expect(d.registry.get("127.0.0.1")).toBeUndefined();
  });

  it("a non-zero exit is failed, and the box is still destroyed", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const d = deps(hub, backend);
    backend.onCreate = (ip) => (d.registry.get(ip) as unknown as { finish: (r: unknown) => void }).finish({ exitCode: 1, installedPackages: [] });
    expect((await runOne(leased(), d))?.status).toBe("failed");
    expect(backend.destroyed).toEqual([901]);
  });

  it("the wall clock counts from the script's start and kills the box: timeout, destroyed", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const d = deps(hub, backend);
    backend.onCreate = (ip) => {
      d.registry.markJobFetched(ip);
      d.registry.enterRunPhase(ip);
    };
    const body = await runOne(leased({ limits: { wallSeconds: 1, cpus: 2, memoryMb: 2048, diskMb: 8192, outMb: 1 } }), d);
    expect(body?.status).toBe("timeout");
    expect(body?.infraReason).toBeUndefined();
    expect(body?.log.tail + body!.log.head).toMatch(/ran past its 1 s wall clock/);
    expect(backend.destroyed).toEqual([901]);
  });

  it("a box that never asks for its job is INFRA (it did not start), not a timeout", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const d = { ...deps(hub, backend), bootMs: 50 };
    const body = await runOne(leased(), d);
    expect(body?.status).toBe("infra");
    expect(body?.infraReason).toMatch(/did not ask for its job/);
    expect(backend.destroyed).toEqual([901]);
  });

  it("packages still installing past the setup clock: timeout, said in the log", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const d = { ...deps(hub, backend), setupMs: 50 };
    backend.onCreate = (ip) => d.registry.markJobFetched(ip);
    const body = await runOne(leased(), d);
    expect(body?.status).toBe("timeout");
    expect(body?.log.head).toMatch(/packages were still installing after 0 s/);
  });

  it("a Stop already pending at lease: no box is cloned, finish stopped", async () => {
    const hub = new FakeHub();
    hub.heartbeatImpl = () => ({ leaseExpiresAt: "x", stopRequested: true });
    const backend = new FakeBackend();
    const body = await runOne(leased(), deps(hub, backend));
    expect(body?.status).toBe("stopped");
    expect(backend.created).toEqual([]);
  });

  it("the provisioner stopping mid-run destroys the box and finishes INFRA", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const stop = new AbortController();
    const d = { ...deps(hub, backend), signal: stop.signal };
    backend.onCreate = (ip) => {
      d.registry.markJobFetched(ip);
      setTimeout(() => stop.abort(), 10);
    };
    const body = await runOne(leased(), d);
    expect(body?.status).toBe("infra");
    expect(body?.infraReason).toMatch(/provisioner was stopped/);
    expect(backend.destroyed).toEqual([901]);
  });

  it("limits over the phase 0 caps are cut before the clone, and said in the log", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const asked: Array<{ cpus: number; memoryMb: number }> = [];
    const create = backend.create.bind(backend);
    backend.create = async (runId: string, limits: { cpus: number; memoryMb: number }) => {
      asked.push(limits);
      return create(runId);
    };
    const d = deps(hub, backend);
    backend.onCreate = (ip) => (d.registry.get(ip) as unknown as { finish: (r: unknown) => void }).finish({ exitCode: 0, installedPackages: [] });
    const body = await runOne(leased({ limits: { wallSeconds: 99999, cpus: 16, memoryMb: 65536, diskMb: 8192, outMb: 200 } }), d);
    expect(asked).toEqual([{ cpus: 2, memoryMb: 2048 }]);
    expect(body?.log.head).toMatch(/limits cut to the phase 0 caps: wallSeconds 99999 → 3600, cpus 16 → 2, memoryMb 65536 → 2048/);
  });

  it("an empty /out file is listed, not uploaded (the pod takes no empty file)", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    const d = deps(hub, backend);
    backend.onCreate = (ip) => {
      const box = d.registry.get(ip)!;
      fs.writeFileSync(path.join(box.outDir, "empty.txt"), "");
      box.outFiles.push({ path: "empty.txt", size: 0, sha256: "e3b0" });
      (box as unknown as { finish: (r: unknown) => void }).finish({ exitCode: 0, installedPackages: [] });
    };
    const body = await runOne(leased(), d);
    expect(hub.uploads).toEqual([]);
    expect(body?.files).toEqual([{ path: "empty.txt", size: 0, sha256: "e3b0" }]);
    expect(body?.log.head).toMatch(/empty\.txt \(0 bytes\) was not stored: the file is empty/);
  });

  it("a Stop mid-run ends the run as stopped and destroys the box", async () => {
    const hub = new FakeHub();
    hub.heartbeatImpl = (n) => ({ leaseExpiresAt: "x", stopRequested: n >= 2 });
    const backend = new FakeBackend();
    const d = deps(hub, backend);
    backend.onCreate = (ip) => d.registry.enterRunPhase(ip); // its beat learns of the Stop
    const body = await runOne(leased(), d);
    expect(body?.status).toBe("stopped");
    expect(backend.destroyed).toEqual([901]);
  });

  it("a lost lease destroys the box and sends NO finish", async () => {
    const hub = new FakeHub();
    hub.heartbeatImpl = (n) => {
      if (n >= 2) throw new LeaseLostError("r", 409);
      return { leaseExpiresAt: "x", stopRequested: false };
    };
    const backend = new FakeBackend();
    const d = deps(hub, backend);
    backend.onCreate = (ip) => d.registry.enterRunPhase(ip); // the phase beat is the one that learns it
    expect(await runOne(leased(), d)).toBeNull();
    expect(backend.destroyed).toEqual([901]);
    expect(hub.finished).toEqual([]);
  });

  it("a lease lost before any box: nothing created, no finish", async () => {
    const hub = new FakeHub();
    hub.heartbeatImpl = () => {
      throw new LeaseLostError("r", 404);
    };
    const backend = new FakeBackend();
    expect(await runOne(leased(), deps(hub, backend))).toBeNull();
    expect(backend.created).toEqual([]);
    expect(hub.finished).toEqual([]);
  });

  it("a failed clone is INFRA, not the script's failure", async () => {
    const hub = new FakeHub();
    const backend = new FakeBackend();
    backend.failCreate = true;
    const body = await runOne(leased(), deps(hub, backend));
    expect(body?.status).toBe("infra");
    expect(body?.infraReason).toMatch(/clone failed: storage full/);
    expect(body?.exitCode).toBeNull();
  });

  it("a file the pod cannot store is said in the log, never silently dropped", async () => {
    const hub = new FakeHub();
    hub.uploadImpl = () => {
      throw new WorkspaceRequiredError();
    };
    const backend = new FakeBackend();
    const d = deps(hub, backend);
    backend.onCreate = (ip) => {
      const box = d.registry.get(ip)!;
      fs.writeFileSync(path.join(box.outDir, "a.csv"), "x");
      box.outFiles.push({ path: "a.csv", size: 1, sha256: "h" });
      (box as unknown as { finish: (r: unknown) => void }).finish({ exitCode: 0, installedPackages: [] });
    };
    const body = await runOne(leased(), d);
    expect(body?.files).toEqual([{ path: "a.csv", size: 1, sha256: "h" }]);
    expect(body?.log.head).toMatch(/\/out\/a\.csv \(1 bytes\) was not stored: the run has no workspace/);
  });
});

describe("guards and the serve loop", () => {
  it("checkGuards waits on low memory or a full pool", () => {
    const g = { minMemAvailableMb: 6144, maxStorageUsedPct: 85 };
    const g2 = { ...g, maxMetaUsedPct: 70 };
    expect(checkGuards({ memAvailableMb: 14000, storageUsedPct: 69, metaUsedPct: 15 }, g2)).toEqual({ ok: true });
    expect(checkGuards({ memAvailableMb: 5000, storageUsedPct: 69, metaUsedPct: 15 }, g2)).toMatchObject({ ok: false, reason: /MemAvailable/ });
    expect(checkGuards({ memAvailableMb: 14000, storageUsedPct: 90, metaUsedPct: 15 }, g2)).toMatchObject({ ok: false, reason: /90\.0% full/ });
    expect(checkGuards({ memAvailableMb: 14000, storageUsedPct: 69, metaUsedPct: 71 }, g2)).toMatchObject({ ok: false, reason: /metadata 71\.0% full/ });
    expect(checkGuards({ memAvailableMb: 14000, storageUsedPct: 69, metaUsedPct: null }, g2)).toEqual({ ok: true });
  });

  it("a short host leases NOTHING: the run keeps its turn on the pod", async () => {
    const hub = new FakeHub();
    hub.leases = [leased()];
    const backend = new FakeBackend();
    backend.reading = { memAvailableMb: 1000, storageUsedPct: 69, metaUsedPct: 15 };
    const d = deps(hub, backend);
    await serve(d, { guards: { minMemAvailableMb: 6144, maxStorageUsedPct: 85, maxMetaUsedPct: 70 }, idleMs: 0, guardWaitMs: 0, once: true });
    expect(hub.leaseCalls).toBe(0);
    expect(d.lines.join("\n")).toMatch(/waiting, turn kept: host MemAvailable 1000 MB/);
  });

  it("the reaper destroys every box no run holds, at start", async () => {
    const backend = new FakeBackend();
    backend.boxes.set(902, "box-old");
    backend.boxes.set(903, "box-held");
    const lines: string[] = [];
    expect(await reap(backend, new Set([903]), (l) => lines.push(l))).toEqual([902]);
    expect([...backend.boxes.keys()]).toEqual([903]);
  });
});

// ─── wire ────────────────────────────────────────────────────────────────────

describe("createBoxHub (BOX-CONTRACT v2)", () => {
  type Call = { url: string; init: RequestInit };
  function fakeFetch(responses: Array<() => Response>) {
    const calls: Call[] = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift()!();
    };
    return { calls, impl };
  }
  const json = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("lease: {run:null} is nothing queued; the computer key is sent", async () => {
    const f = fakeFetch([json(200, { run: null })]);
    const hub = createBoxHub({ podUrl: "https://pod.x/", apiKey: "k" }, f.impl);
    expect(await hub.lease()).toBeNull();
    expect(f.calls[0].url).toBe("https://pod.x/api/hub/box-runs/lease");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("heartbeat sends leaseId + phase; 409 is a lost lease", async () => {
    const f = fakeFetch([json(200, { leaseExpiresAt: "t", stopRequested: true }), json(409, { code: "LEASE_LOST" })]);
    const hub = createBoxHub({ podUrl: "https://pod.x", apiKey: "k" }, f.impl);
    expect(await hub.heartbeat(leased(), "running")).toEqual({ leaseExpiresAt: "t", stopRequested: true });
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ leaseId: "lease-1", phase: "running" });
    await expect(hub.heartbeat(leased(), "running")).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("upload: ticket, then PUT with exactly the signed headers, returns the token", async () => {
    const f = fakeFetch([
      json(200, { uploadUrl: "https://s3/x", method: "PUT", headers: { "Content-Type": "image/png" }, uploadToken: "sau1.t", expiresAt: "e", maxBytes: 9 }),
      () => new Response(null, { status: 200 }),
    ]);
    const hub = createBoxHub({ podUrl: "https://pod.x", apiKey: "k" }, f.impl);
    expect(await hub.upload(leased(), { filename: "c.png", mimeType: "image/png", bytes: Buffer.from("PNG") })).toBe("sau1.t");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ leaseId: "lease-1", filename: "c.png", mimeType: "image/png", size: 3 });
    expect(f.calls[1]).toMatchObject({ url: "https://s3/x", init: { method: "PUT", headers: { "Content-Type": "image/png" } } });
  });

  it("WORKSPACE_REQUIRED is its own error", async () => {
    const f = fakeFetch([json(400, { code: "WORKSPACE_REQUIRED" })]);
    const hub = createBoxHub({ podUrl: "https://pod.x", apiKey: "k" }, f.impl);
    await expect(hub.upload(leased(), { filename: "a", mimeType: "text/plain", bytes: Buffer.from("a") })).rejects.toBeInstanceOf(
      WorkspaceRequiredError
    );
  });
});
