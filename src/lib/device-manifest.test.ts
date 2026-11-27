import { describe, expect, it, vi } from "vitest";
import {
  capabilitiesFrom,
  collectDeviceManifest,
  createDeviceReporter,
  MANIFEST_TTL_MS,
  parseDf,
  parseNvidiaSmi,
  parseSystemProfilerGpus,
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
};

describe("collectDeviceManifest", () => {
  const run: RunProbe = async (cmd) => {
    if (cmd === "df") return LINUX_DF;
    if (cmd === "nvidia-smi") return "NVIDIA GeForce RTX 4090, 24564 MiB\n";
    throw new Error("no");
  };

  it("builds a valid manifest from every probe", async () => {
    const m = await collectDeviceManifest({ wakesAgents: true }, { run, os: fakeOs, platform: "linux" });
    expect(m.resources?.cpu).toEqual({ model: "Apple M3 Pro", cores: 2 });
    expect(m.resources?.memoryMb).toBe(36864);
    expect(m.resources?.gpus).toEqual([{ model: "NVIDIA GeForce RTX 4090", vramMb: 24564 }]);
    expect(m.resources?.disks?.map((d) => d.mount)).toEqual(["/", "/data"]);
    expect(m.identity).toEqual({ os: "darwin", arch: "arm64", hostname: "mac.local" });
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
    const m = await collectDeviceManifest({}, { run, os: broken, platform: "linux" });
    expect(m.resources?.cpu).toBeUndefined();
    expect(m.resources?.memoryMb).toBeUndefined();
    expect(m.resources?.disks).toBeDefined();
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

  it("probes at most once per TTL and recomputes capabilities per call", async () => {
    let t = 0;
    const collect = vi.fn(async () => manifest);
    const r = createDeviceReporter({ collect, now: () => t });
    expect((await r.manifest({ wakesAgents: true }))?.capabilities).toEqual(["wake.agent"]);
    expect((await r.manifest({}))?.capabilities).toBeUndefined();
    expect(collect).toHaveBeenCalledTimes(1);
    t = MANIFEST_TTL_MS;
    await r.manifest({});
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("posts to the report door at most once per TTL", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ device: { manifest: "accepted" } }), { status: 200 }));
    const r = createDeviceReporter({ collect: async () => manifest, now: () => t, fetchImpl: fetchImpl as never });
    await r.report("https://pod.example/", "key", {});
    await r.report("https://pod.example/", "key", {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pod.example/api/hub/computers/me/report");
    expect(JSON.parse(String(init.body))).toEqual({ manifest });
    t = MANIFEST_TTL_MS;
    await r.report("https://pod.example/", "key", {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a pod without the door (404) is left alone for an hour; a thrown fetch never throws", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => new Response("nf", { status: 404 }));
    const r = createDeviceReporter({ collect: async () => manifest, now: () => t, fetchImpl: fetchImpl as never });
    await r.report("https://old.pod", "k");
    t = MANIFEST_TTL_MS + 1;
    await r.report("https://old.pod", "k");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const boom = createDeviceReporter({ collect: async () => manifest, fetchImpl: (async () => { throw new Error("net"); }) as never });
    await expect(boom.report("https://x", "k")).resolves.toBeUndefined();
  });

  it("never sends an invalid manifest", async () => {
    const fetchImpl = vi.fn();
    const r = createDeviceReporter({ collect: async () => ({ manifestVersion: 1, capabilities: ["NOPE"] }) as never, fetchImpl: fetchImpl as never, log: () => {} });
    await r.report("https://x", "k");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
