/**
 * The Proxmox backend of the run box: one fresh unprivileged LXC per run,
 * linked-cloned from a template CT, on the isolated box bridge, destroyed after.
 *
 * It talks to the Proxmox API with a POOL-SCOPED token (least privilege: it
 * can clone, configure, start, stop and destroy guests of ONE pool, and read
 * node memory, one storage's fill and the thin pools' fill — nothing else;
 * host side in `my server` docs/RUNBOX.md, `scripts/box/setup-box-access.sh`). TLS is verified against the host's own CA, pinned by file,
 * never `rejectUnauthorized: false`.
 */

import https from "node:https";

export interface ProxmoxConfig {
  /** e.g. https://10.10.0.1:8006 */
  endpoint: string;
  /** `user@realm!tokenid=secret` */
  token: string;
  /** PEM of the host CA (/etc/pve/pve-root-ca.pem). */
  ca: string;
  node: string;
  /**
   * The name the host certificate is checked against when the endpoint is an
   * address it does not list. The founder's host cert names 192.168.1.201,
   * `main` and `main.local.lan`, not 10.10.0.1 (read 2026-10-26), so the
   * provisioner connects to 10.10.0.1 and verifies the cert as `main`.
   */
  serverName?: string;
}

export interface ProxmoxApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, params?: Record<string, string | number>): Promise<T>;
  put<T>(path: string, params?: Record<string, string | number>): Promise<T>;
  del<T>(path: string, params?: Record<string, string | number>): Promise<T>;
}

export class ProxmoxError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProxmoxError";
  }
}

export function createProxmoxApi(cfg: ProxmoxConfig): ProxmoxApi {
  const base = new URL("/api2/json", cfg.endpoint);
  const agent = new https.Agent({ ca: cfg.ca, keepAlive: true, ...(cfg.serverName ? { servername: cfg.serverName } : {}) });

  function request<T>(method: string, path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(base.pathname + path, base);
    let body: string | undefined;
    const form = params
      ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
      : "";
    if (method === "GET" || method === "DELETE") {
      if (form) url.search = form;
    } else {
      body = form;
    }
    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          agent,
          headers: {
            Authorization: `PVEAPIToken=${cfg.token}`,
            ...(body !== undefined
              ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
              : {}),
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400) {
              reject(new ProxmoxError(res.statusCode ?? 500, `${method} ${path}: HTTP ${res.statusCode} ${res.statusMessage ?? ""} ${text.slice(0, 300)}`.trim()));
              return;
            }
            try {
              resolve((JSON.parse(text) as { data: T }).data);
            } catch {
              reject(new ProxmoxError(res.statusCode ?? 500, `${method} ${path}: not JSON`));
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error(`${method} ${path}: timed out`)));
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  return {
    get: (p) => request("GET", p),
    post: (p, params) => request("POST", p, params),
    put: (p, params) => request("PUT", p, params),
    del: (p, params) => request("DELETE", p, params),
  };
}

// ─── the backend ─────────────────────────────────────────────────────────────

export interface BoxHostConfig {
  /** VMID of the template CT (a Proxmox template, linked clones only). */
  templateVmid: number;
  /** The pool every box is created in; the token can touch nothing else. */
  pool: string;
  /** Storage the template and its linked clones live on (the fill guard reads it). */
  storage: string;
  /**
   * The LVM thin pool behind `storage`, `vg/lv` (e.g. `pve/data`), for the
   * metadata guard. Unset = no metadata guard (said once at start).
   */
  thinpool?: string;
  /** The isolated box bridge. */
  bridge: string;
  /** First three octets of the box subnet, e.g. "10.20.0". */
  subnetPrefix: string;
  /** VMIDs reserved for boxes, inclusive. */
  vmidMin: number;
  vmidMax: number;
  cpuunits: number;
}

/** Every box carries this tag; the reaper touches nothing without it. */
export const BOX_TAG = "synap-box";

export interface BoxHandle {
  vmid: number;
  ip: string;
}

export interface HostReading {
  memAvailableMb: number;
  storageUsedPct: number;
  /** Thin pool metadata fill; null only when no `thinpool` is configured (never for a failed read: that throws). */
  metaUsedPct: number | null;
}

export interface ListedBox {
  vmid: number;
  name: string;
}

export interface BoxBackend {
  readHost(): Promise<HostReading>;
  /** Clone, size, attach to the bridge and start a box for one run. */
  create(runId: string, limits: { cpus: number; memoryMb: number }): Promise<BoxHandle>;
  /** Stop and destroy; idempotent (a box already gone is success). */
  destroy(vmid: number): Promise<void>;
  /** Every tagged box in the pool (the reaper destroys those no run holds). */
  list(): Promise<ListedBox[]>;
}

/** The IP a box gets on the bridge, by its VMID slot (.10 upward). */
export function boxIpFor(cfg: BoxHostConfig, vmid: number): string {
  return `${cfg.subnetPrefix}.${10 + (vmid - cfg.vmidMin)}`;
}

type ClusterGuest = { vmid?: number; type?: string; name?: string; pool?: string; tags?: string; template?: number };

/**
 * The boxes the reaper may destroy: guests of the box pool, in the box VMID
 * range, tagged `synap-box`, never the template. Read from /cluster/resources
 * (VM.Audit + Pool.Audit on the pool), not the deprecated GET /pools/{id}.
 */
export function boxesOf(cfg: BoxHostConfig, guests: readonly ClusterGuest[]): ListedBox[] {
  return guests
    .filter((g) => g.type === "lxc" && typeof g.vmid === "number" && g.pool === cfg.pool)
    .filter((g) => g.vmid !== cfg.templateVmid && !g.template)
    .filter((g) => g.vmid! >= cfg.vmidMin && g.vmid! <= cfg.vmidMax)
    .filter((g) => (g.tags ?? "").split(/[;, ]/).includes(BOX_TAG))
    .map((g) => ({ vmid: g.vmid!, name: g.name ?? "" }));
}

type ThinPool = { lv: string; vg: string; metadata_size: number; metadata_used: number };

/** Metadata fill of `vg/lv`; throws when the pool is not listed (a missing reading is never "fine"). */
export function thinMetaPct(spec: string, pools: readonly ThinPool[]): number {
  const [vg, lv] = spec.split("/");
  const p = pools.find((t) => t.vg === vg && t.lv === lv);
  if (!p) throw new Error(`thin pool ${spec} not found on the node`);
  return p.metadata_size > 0 ? (p.metadata_used / p.metadata_size) * 100 : 100;
}

type Task = { status: string; exitstatus?: string };

export function createProxmoxBackend(api: ProxmoxApi, node: string, cfg: BoxHostConfig): BoxBackend {
  const n = encodeURIComponent(node);

  async function waitTask(upid: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = await api.get<Task>(`/nodes/${n}/tasks/${encodeURIComponent(upid)}/status`);
      if (t.status === "stopped") {
        if (t.exitstatus !== "OK") throw new ProxmoxError(500, `task ${upid} ended: ${t.exitstatus}`);
        return;
      }
      if (Date.now() > deadline) throw new ProxmoxError(504, `task ${upid} still running after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /**
   * The first VMID of the box range that is free cluster-wide. /cluster/resources
   * shows only the guests this token may audit (the pool), so each candidate is
   * confirmed by /cluster/nextid?vmid=N, which checks every guest.
   */
  async function freeVmid(): Promise<number | null> {
    const seen = new Set(
      (await api.get<ClusterGuest[]>(`/cluster/resources?type=vm`)).map((g) => g.vmid).filter((v): v is number => typeof v === "number")
    );
    for (let id = cfg.vmidMin; id <= cfg.vmidMax; id++) {
      if (seen.has(id)) continue;
      try {
        await api.get(`/cluster/nextid?vmid=${id}`);
        return id;
      } catch (err) {
        if (err instanceof ProxmoxError && err.status === 400) continue; // "VM <id> already exists"
        throw err;
      }
    }
    return null;
  }

  async function destroy(vmid: number): Promise<void> {
    try {
      const st = await api.get<{ status: string }>(`/nodes/${n}/lxc/${vmid}/status/current`);
      if (st.status === "running") {
        await waitTask(await api.post<string>(`/nodes/${n}/lxc/${vmid}/status/stop`));
      }
      await waitTask(await api.del<string>(`/nodes/${n}/lxc/${vmid}`, { purge: 1, "destroy-unreferenced-disks": 1 }));
    } catch (err) {
      // A box already gone is the outcome we want.
      if (err instanceof ProxmoxError && (err.status === 404 || /does not exist/.test(err.message))) return;
      throw err;
    }
  }

  return {
    async readHost() {
      // `memory.free` here is MemFree; total - used is MemAvailable (read on
      // the host 2026-10-26: within 1% of /proc/meminfo MemAvailable).
      const status = await api.get<{ memory: { total: number; used: number } }>(`/nodes/${n}/status`);
      const st = await api.get<{ total: number; used: number }>(
        `/nodes/${n}/storage/${encodeURIComponent(cfg.storage)}/status`
      );
      const metaUsedPct = cfg.thinpool
        ? thinMetaPct(cfg.thinpool, await api.get<ThinPool[]>(`/nodes/${n}/disks/lvmthin`))
        : null;
      return {
        memAvailableMb: Math.floor((status.memory.total - status.memory.used) / 1024 / 1024),
        storageUsedPct: st.total > 0 ? (st.used / st.total) * 100 : 100,
        metaUsedPct,
      };
    },

    async create(runId, limits) {
      const vmid = await freeVmid();
      if (vmid === null) throw new ProxmoxError(503, `no free VMID in ${cfg.vmidMin}-${cfg.vmidMax}`);
      const ip = boxIpFor(cfg, vmid);
      const upid = await api.post<string>(`/nodes/${n}/lxc/${cfg.templateVmid}/clone`, {
        newid: vmid,
        hostname: `box-${runId.slice(0, 8)}`,
        pool: cfg.pool,
        full: 0,
        description: `synap box run ${runId}`,
      });
      await waitTask(upid);
      try {
        await api.put(`/nodes/${n}/lxc/${vmid}/config`, {
          cores: limits.cpus,
          memory: limits.memoryMb,
          swap: 0,
          cpuunits: cfg.cpuunits,
          // No gateway: the box's only reachable neighbour is the provisioner.
          net0: `name=eth0,bridge=${cfg.bridge},ip=${ip}/24,firewall=0`,
          tags: `${BOX_TAG};run-${runId.slice(0, 8)}`,
          onboot: 0,
        });
        await waitTask(await api.post<string>(`/nodes/${n}/lxc/${vmid}/status/start`));
      } catch (err) {
        await destroy(vmid).catch(() => undefined);
        throw err;
      }
      return { vmid, ip };
    },

    destroy,

    async list() {
      return boxesOf(cfg, await api.get<ClusterGuest[]>(`/cluster/resources?type=vm`));
    },
  };
}
