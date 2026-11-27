import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capabilitiesFrom,
  collectDeviceManifest,
  createDeviceReporter,
  DEVICE_REPORTER_NAME,
  DEVICE_REPORTERS,
  MANIFEST_TTL_MS,
  parseDf,
  parseNvidiaSmi,
  parseOsReleaseVersion,
  parseSystemProfilerGpus,
  REPORT_EVERY_MS,
  validateDeviceManifest,
  type RunProbe,
} from "./device-manifest.js";

const LINUX_DF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
udev               16318464         0  16318464       0% /dev
tmpfs               3268180      2016   3266164       1% /run
/dev/nvme0n1p2    490690936 120000000 345000000      26% /
tmpfs              16340896         0  16340896       0% /dev/shm
/dev/loop3            56704     56704         0     100% /snap/core20/1974
overlay           490690936 120000000 345000000      26% /var/lib/docker/overlay2/x/merged
/dev/sda1        3845622784 100000000 3500000000       3% /data
/dev/nvme0n1p2    490690936 120000000 345000000      26% /etc/hosts
/dev/nvme0n1p1       523248      6220     517028       2% /boot/efi
`;

const MAC_DF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/disk3s1s1   971350180  15000000 480000000     4% /
devfs                  223       223         0   100% /dev
/dev/disk3s6     971350180   2000000 480000000     1% /System/Volumes/VM
/dev/disk3s5     971350180 450000000 480000000    49% /System/Volumes/Data
map auto_home            0         0         0   100% /System/Volumes/Data/home
/dev/disk5s1      488050000 100000000 380000000   21% /Volumes/My Backup
`;

describe("parseDf", () => {
  it("keeps real filesystems on linux: skips tmpfs, udev, overlay, snap loops, boot/efi; dedupes bind mounts", () => {
    const d = parseDf(LINUX_DF);
    expect(d.map((x) => x.mount)).toEqual(["/", "/data"]);
    expect(d[0]).toEqual({ mount: "/", sizeMb: 479190, freeMb: 336914 });
  });
  it("handles darwin: skips devfs, map and /System/Volumes, keeps a mount with a space", () => {
    const d = parseDf(MAC_DF);
    expect(d.map((x) => x.mount)).toEqual(["/", "/Volumes/My Backup"]);
  });
  it("returns [] for garbage", () => {
    expect(parseDf("nonsense\n\n")).toEqual([]);
  });
});

describe("parseNvidiaSmi / parseSystemProfilerGpus", () => {
  it("reads name and MiB", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564 MiB\nTesla T4, 15360 MiB\n")).toEqual([
      { model: "NVIDIA GeForce RTX 4090", vramMb: 24564 },
      { model: "Tesla T4", vramMb: 15360 },
    ]);
  });
  it("keeps a model with no memory column", () => {
    expect(parseNvidiaSmi("Quadro K620\n")).toEqual([{ model: "Quadro K620" }]);
  });
  it("reads the macOS profiler json, no vram on Apple silicon", () => {
    expect(parseSystemProfilerGpus(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Apple M3 Pro" }] }))).toEqual([{ model: "Apple M3 Pro" }]);
    expect(parseSystemProfilerGpus("not json")).toEqual([]);
  });
});

const fakeOs = {
  cpus: () => [{ model: "Apple M3 Pro" }, { model: "Apple M3 Pro" }] as never,
  totalmem: () => 36 * 1024 * 1024 * 1024,
  platform: () => "darwin" as NodeJS.Platform,
  arch: () => "arm64",
  hostname: () => "mac.local",
  release: () => "25.5.0",
};

const UBUNTU_OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
`;
const readUbuntu = async () => UBUNTU_OS_RELEASE;
const unreadable = async (): Promise<string> => {
  throw new Error("ENOENT");
};

describe("collectDeviceManifest", () => {
  const run: RunProbe = async (cmd) => {
    if (cmd === "df") return LINUX_DF;
    if (cmd === "nvidia-smi") return "NVIDIA GeForce RTX 4090, 24564 MiB\n";
    throw new Error("no");
  };

  it("builds a valid manifest from every probe", async () => {
    const m = await collectDeviceManifest({ wakesAgents: true }, { run, os: fakeOs, platform: "linux", readText: readUbuntu });
    expect(m.resources?.cpu).toEqual({ model: "Apple M3 Pro", cores: 2 });
    expect(m.resources?.memoryMb).toBe(36864);
    expect(m.resources?.gpus).toEqual([{ model: "NVIDIA GeForce RTX 4090", vramMb: 24564 }]);
    expect(m.resources?.disks?.map((d) => d.mount)).toEqual(["/", "/data"]);
    expect(m.identity).toEqual({ os: "darwin", osVersion: "24.04", arch: "arm64", hostname: "mac.local" });
    expect(m.capabilities).toEqual(["wake.agent"]);
    expect(validateDeviceManifest(m)).toBeNull();
    expect(JSON.stringify(m)).not.toContain("tier");
  });

  it("omits a field whose probe failed, never invents it", async () => {
    const failing: RunProbe = async () => {
      throw new Error("boom");
    };
    const m = await collectDeviceManifest({}, { run: failing, os: fakeOs, platform: "darwin" });
    expect(m.resources?.disks).toBeUndefined();
    expect(m.resources?.gpus).toBeUndefined();
    expect(m.capabilities).toBeUndefined();
    expect(m.resources?.memoryMb).toBe(36864);
    expect(validateDeviceManifest(m)).toBeNull();
  });

  it("survives an os module that throws", async () => {
    const broken = { ...fakeOs, cpus: () => { throw new Error("x"); }, totalmem: () => { throw new Error("x"); } };
    const m = await collectDeviceManifest({}, { run, os: broken, platform: "linux", readText: readUbuntu });
    expect(m.resources?.cpu).toBeUndefined();
    expect(m.resources?.memoryMb).toBeUndefined();
    expect(m.resources?.disks).toBeDefined();
  });
});

describe("identity.osVersion", () => {
  it("macOS: the product version from sw_vers, not the Darwin kernel's", async () => {
    const run: RunProbe = async (cmd, args) => {
      if (cmd === "sw_vers" && args[0] === "-productVersion") return "15.1\n";
      throw new Error("no");
    };
    const m = await collectDeviceManifest({}, { run, os: fakeOs, platform: "darwin", readText: unreadable });
    expect(m.identity?.osVersion).toBe("15.1");
    expect(validateDeviceManifest(m)).toBeNull();
  });

  it("linux: VERSION_ID from /etc/os-release", async () => {
    const paths: string[] = [];
    const readText = async (p: string) => (paths.push(p), UBUNTU_OS_RELEASE);
    const m = await collectDeviceManifest({}, { run: unreadable, os: fakeOs, platform: "linux", readText });
    expect(paths).toEqual(["/etc/os-release"]);
    expect(m.identity?.osVersion).toBe("24.04");
  });

  it("falls back to the kernel release when the OS's own version cannot be read", async () => {
    const m = await collectDeviceManifest({}, { run: unreadable, os: fakeOs, platform: "linux", readText: unreadable });
    expect(m.identity?.osVersion).toBe("25.5.0");
  });

  it("is left out, never invented, when nothing can be read; the collector does not throw", async () => {
    const noRelease = { ...fakeOs, release: () => { throw new Error("x"); } };
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const m = await collectDeviceManifest({}, { run: unreadable, os: noRelease, platform, readText: unreadable });
      expect(m.identity).toEqual({ os: "darwin", arch: "arm64", hostname: "mac.local" });
      expect(validateDeviceManifest(m)).toBeNull();
    }
  });

  it("parseOsReleaseVersion: quoted, bare, absent", () => {
    expect(parseOsReleaseVersion(UBUNTU_OS_RELEASE)).toBe("24.04");
    expect(parseOsReleaseVersion("ID=debian\nVERSION_ID=12\n")).toBe("12");
    expect(parseOsReleaseVersion("NAME=\"Arch Linux\"\nID=arch\n")).toBeUndefined();
    expect(parseOsReleaseVersion('VERSION_ID=""\n')).toBeUndefined();
  });

  it("the local check holds osVersion to the backend's Word(120)", () => {
    expect(validateDeviceManifest({ manifestVersion: 1, identity: { osVersion: "x".repeat(121) } })).toMatch(/osVersion/);
    expect(validateDeviceManifest({ manifestVersion: 1, identity: { osVersion: " " } })).toMatch(/osVersion/);
  });
});

describe("capabilitiesFrom / validateDeviceManifest", () => {
  it("maps the three flags", () => {
    expect(capabilitiesFrom({ runsScripts: true, wakesAgents: true, hostsServices: true })).toEqual(["run.tool", "wake.agent", "serve.http"]);
    expect(capabilitiesFrom({})).toEqual([]);
  });
  it("refuses what the backend schema refuses", () => {
    expect(validateDeviceManifest({ manifestVersion: 2 })).toMatch(/manifestVersion/);
    expect(validateDeviceManifest({ manifestVersion: 1, capabilities: ["Bad Name"] })).toMatch(/capabilities/);
    expect(validateDeviceManifest({ manifestVersion: 1, resources: { disks: [{ mount: "/", sizeMb: -1, freeMb: 0 }] } })).toMatch(/disks/);
    expect(validateDeviceManifest({ manifestVersion: 1, resources: { memoryMb: 1.5 } })).toMatch(/memoryMb/);
  });
});

describe("createDeviceReporter", () => {
  const manifest = { manifestVersion: 1 as const, resources: { memoryMb: 100 } };
  const ok = () => vi.fn(async () => new Response(JSON.stringify({ device: { manifest: "accepted" } }), { status: 200 }));
  const bodyOf = (fetchImpl: ReturnType<typeof ok>, i: number) =>
    JSON.parse(String((fetchImpl.mock.calls[i] as unknown as [string, RequestInit])[1].body)) as { reporter: string; manifest: Record<string, unknown> };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("probes at most once per TTL; capabilities follow the flags on every call, an empty set included", async () => {
    let t = 0;
    const collect = vi.fn(async () => manifest);
    const r = createDeviceReporter({ reporter: "worker", collect, now: () => t });
    expect((await r.manifest({ wakesAgents: true }))?.capabilities).toEqual(["wake.agent"]);
    expect((await r.manifest({}))?.capabilities).toEqual([]);
    expect(await r.manifest()).not.toHaveProperty("capabilities");
    expect(collect).toHaveBeenCalledTimes(1);
    t = MANIFEST_TTL_MS;
    await r.manifest({});
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("posts to the report door, naming its process, at most once per REPORT_EVERY_MS", async () => {
    let t = 0;
    const fetchImpl = ok();
    const r = createDeviceReporter({ reporter: "worker", collect: async () => manifest, now: () => t, fetchImpl: fetchImpl as never });
    await r.report("https://pod.example/", "key", {});
    await r.report("https://pod.example/", "key", {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pod.example/api/hub/computers/me/report");
    expect(bodyOf(fetchImpl, 0)).toEqual({ reporter: "worker", manifest: { ...manifest, capabilities: [] } });
    t = REPORT_EVERY_MS - 1;
    await r.report("https://pod.example/", "key", {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = REPORT_EVERY_MS;
    await r.report("https://pod.example/", "key", {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("each process sends its own name, and every name passes the backend's DEVICE_REPORTER", async () => {
    const backend = /^[a-z][a-z0-9-]{0,31}$/;
    expect(DEVICE_REPORTER_NAME.source).toBe(backend.source);
    expect([...DEVICE_REPORTERS].sort()).toEqual(["host", "waker", "worker"]);
    for (const reporter of DEVICE_REPORTERS) {
      expect(reporter).toMatch(backend);
      const fetchImpl = ok();
      await createDeviceReporter({ reporter, collect: async () => manifest, fetchImpl: fetchImpl as never }).report("https://x", "k", {});
      expect(bodyOf(fetchImpl, 0).reporter).toBe(reporter);
    }
  });

  it("a change of capabilities is sent at once (a flag turned off says []); unknown flags leave them out", async () => {
    const fetchImpl = ok();
    const r = createDeviceReporter({ reporter: "waker", collect: async () => manifest, now: () => 0, fetchImpl: fetchImpl as never });
    await r.report("https://x", "k", { wakesAgents: true });
    await r.report("https://x", "k", { wakesAgents: true });
    await r.report("https://x", "k", { wakesAgents: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl, 0).manifest.capabilities).toEqual(["wake.agent"]);
    expect(bodyOf(fetchImpl, 1).manifest.capabilities).toEqual([]);
    // Unknown is not a change: nothing is due.
    await r.report("https://x", "k", () => undefined);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const later = ok();
    await createDeviceReporter({ reporter: "waker", collect: async () => manifest, fetchImpl: later as never }).report("https://x", "k", () => undefined);
    expect(bodyOf(later, 0).manifest).not.toHaveProperty("capabilities");
  });

  it("keepReporting: reports at once, then never more than 10 minutes apart, and stops when told", async () => {
    vi.useFakeTimers();
    const sentAt: number[] = [];
    const fetchImpl = vi.fn(async () => {
      sentAt.push(Date.now());
      // A plain answer: only microtasks between the fake timers.
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const start = Date.now();
    const r = createDeviceReporter({ reporter: "host", collect: async () => manifest, now: () => Date.now(), fetchImpl: fetchImpl as never });
    const stop = r.keepReporting("https://x", "k", { hostsServices: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sentAt).toEqual([start]);
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    const gaps = sentAt.slice(1).map((at, i) => at - sentAt[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(6);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(10 * 60_000);
    expect(Date.now() - sentAt.at(-1)!).toBeLessThanOrEqual(10 * 60_000);
    expect(bodyOf(fetchImpl as never, 0)).toEqual({ reporter: "host", manifest: { ...manifest, capabilities: ["serve.http"] } });
    stop();
    const n = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(n);
  });

  it("one send at a time: a slow pod never piles reports up", async () => {
    let release!: () => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((res) => (release = () => res(new Response("{}", { status: 200 })))));
    const r = createDeviceReporter({ reporter: "worker", collect: async () => manifest, now: () => 0, fetchImpl: fetchImpl as never });
    const first = r.report("https://x", "k", { wakesAgents: true });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await r.report("https://x", "k", { wakesAgents: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("a pod without the door (404) is left alone for an hour; a thrown fetch never throws", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => new Response("nf", { status: 404 }));
    const r = createDeviceReporter({ reporter: "worker", collect: async () => manifest, now: () => t, fetchImpl: fetchImpl as never });
    await r.report("https://old.pod", "k");
    t = MANIFEST_TTL_MS + 1;
    await r.report("https://old.pod", "k", { wakesAgents: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const boom = createDeviceReporter({ reporter: "worker", collect: async () => manifest, fetchImpl: (async () => { throw new Error("net"); }) as never });
    await expect(boom.report("https://x", "k")).resolves.toBeUndefined();
    await expect(boom.report("https://x", "k", () => { throw new Error("flags"); })).resolves.toBeUndefined();
  });

  it("never sends an invalid manifest", async () => {
    const fetchImpl = vi.fn();
    const r = createDeviceReporter({ reporter: "worker", collect: async () => ({ manifestVersion: 1, capabilities: ["NOPE"] }) as never, fetchImpl: fetchImpl as never, log: () => {} });
    await r.report("https://x", "k");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
