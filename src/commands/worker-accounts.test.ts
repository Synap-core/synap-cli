import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccountPool,
  loadAccountsFile,
  probeAccount,
  reserveIds,
  selectAccount,
  standingOf,
  type AccountsFile,
  type Meter,
  type ProbeResult,
  type Standing,
} from "./worker-accounts.js";

const T = Date.parse("2026-10-24T06:00:00Z");
const H = 3_600_000;
const meter = (m: Partial<Meter>): Meter => ({ rejected: false, checkedAt: T, ...m });
const room = (m: Partial<Meter>): Standing => ({ kind: "room", meter: meter(m) });

const file = (over: Partial<AccountsFile> = {}): AccountsFile => ({
  version: 1,
  reserve: 0,
  accounts: [
    { id: "dev", label: "Dev", token: "tok-dev", design: true },
    { id: "a", label: "A", token: "tok-a" },
    { id: "b", label: "B", token: "tok-b" },
    { id: "c", label: "C", token: "tok-c" },
  ],
  ...over,
});

describe("selectAccount", () => {
  it("picks the account whose 5-hour window resets soonest (use it or lose it)", () => {
    const s = new Map<string, Standing>([
      ["dev", room({ fiveHour: 10, fiveHourReset: T + 4 * H, week: 10 })],
      ["a", room({ fiveHour: 10, fiveHourReset: T + 3 * H, week: 10 })],
      ["b", room({ fiveHour: 50, fiveHourReset: T + 1 * H, week: 10 })],
      ["c", room({ fiveHour: 10, fiveHourReset: T + 2 * H, week: 10 })],
    ]);
    expect(selectAccount(file(), s, { design: false }).account?.id).toBe("b");
  });

  it("ties on the reset go to file order", () => {
    const s = new Map<string, Standing>([
      ["a", room({ fiveHourReset: T + H })],
      ["b", room({ fiveHourReset: T + H })],
    ]);
    expect(selectAccount(file(), s, { design: false }).account?.id).toBe("a");
  });

  it("leaves out the reserve: the non-design accounts with the most WEEKLY room left", () => {
    // b resets soonest, but b and c have the most weekly room: they stay for the person.
    const s = new Map<string, Standing>([
      ["dev", room({ fiveHourReset: T + 5 * H, week: 90 })],
      ["a", room({ fiveHourReset: T + 3 * H, week: 80 })],
      ["b", room({ fiveHourReset: T + 1 * H, week: 5 })],
      ["c", room({ fiveHourReset: T + 2 * H, week: 20 })],
    ]);
    expect([...reserveIds(file().accounts, s, 2)].sort()).toEqual(["b", "c"]);
    expect(selectAccount(file({ reserve: 2 }), s, { design: false }).account?.id).toBe("a");
  });

  it("the design account is never counted in the reserve", () => {
    const s = new Map<string, Standing>([
      ["dev", room({ week: 0 })],
      ["a", room({ week: 50 })],
      ["b", room({ week: 60 })],
    ]);
    expect([...reserveIds(file().accounts, s, 1)]).toEqual(["a"]);
  });

  it("an UNMEASURED account is never picked — a failed probe is not room", () => {
    const s = new Map<string, Standing>([
      ["a", { kind: "unmeasured", reason: "probe failed: TypeError" }],
      ["b", { kind: "refused", reason: "HTTP 401" }],
      ["c", { kind: "full", until: T + H }],
    ]);
    const sel = selectAccount(file(), s, { design: false });
    expect(sel.account).toBeUndefined();
    expect(sel.reason).toMatch(/a: unmeasured/);
  });

  it("an unmeasured account is never READ as full either: it is not reserved in place of a measured one", () => {
    const s = new Map<string, Standing>([
      ["a", { kind: "unmeasured", reason: "x" }],
      ["b", room({ week: 10 })],
      ["c", room({ week: 30 })],
    ]);
    // b has the most weekly room among the MEASURED (90% left); a is not ranked at all.
    expect([...reserveIds(file().accounts, s, 1)]).toEqual(["b"]);
    expect(selectAccount(file({ reserve: 1 }), s, { design: false }).account?.id).toBe("c");
  });

  it("a design run takes ONLY the design account, and waits when it has no room", () => {
    const s = new Map<string, Standing>([
      ["dev", { kind: "full", until: T + H }],
      ["a", room({ fiveHourReset: T + H })],
    ]);
    const sel = selectAccount(file(), s, { design: true });
    expect(sel.account).toBeUndefined();
    expect(sel.reason).toMatch(/no design account with room/);
    s.set("dev", room({ fiveHourReset: T + 9 * H }));
    expect(selectAccount(file(), s, { design: true }).account?.id).toBe("dev");
  });

  it("a design run with no design account flagged is refused in words", () => {
    const f = file({ accounts: [{ id: "a", label: "A", token: "t" }] });
    expect(selectAccount(f, new Map([["a", room({})]]), { design: true }).reason).toMatch(/flagged design/);
  });
});

describe("standingOf", () => {
  it("over the threshold is full until the binding window resets", () => {
    const s = standingOf({ kind: "measured", meter: meter({ fiveHour: 96, fiveHourReset: T + H, week: 10 }) }, undefined, T);
    expect(s).toMatchObject({ kind: "full", until: T + H });
  });
  it("a full window whose reset passed is unmeasured until measured again — not room", () => {
    const s = standingOf({ kind: "measured", meter: meter({ fiveHour: 100, fiveHourReset: T - 1 }) }, undefined, T);
    expect(s.kind).toBe("unmeasured");
  });
  it("a run's limit mark wins over an older probe", () => {
    const s = standingOf({ kind: "measured", meter: meter({ fiveHour: 1 }) }, T + H, T);
    expect(s).toMatchObject({ kind: "full", until: T + H });
  });
});

const headers = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [`anthropic-ratelimit-unified-${k}`, v]));
const respond = (status: number, h: Record<string, string> = {}, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers(h) } });

describe("probeAccount (ported from ClaudeSwitch probeOnce)", () => {
  it("200 → measured, utilization as percent, resets in ms", async () => {
    let sent: RequestInit | undefined;
    const r = await probeAccount("sk-ant-oat-x", {
      now: () => T,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        sent = init;
        return respond(200, { status: "allowed", "5h-utilization": "0.25", "5h-reset": "1792725000", "7d-utilization": "0.5", "7d-reset": "1793000000" });
      }) as typeof fetch,
    });
    expect(r).toEqual({
      kind: "measured",
      meter: expect.objectContaining({ fiveHour: 25, fiveHourReset: 1792725000_000, week: 50, weekReset: 1793000000_000, rejected: false }),
    });
    const h = sent?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer sk-ant-oat-x");
    expect(h["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(JSON.parse(String(sent?.body)).max_tokens).toBe(1);
  });

  it("429 rejected → measured full; 429 without rejected → a burst, unmeasured", async () => {
    const full = await probeAccount("t", { fetchImpl: (async () => respond(429, { status: "rejected", reset: "1792725000" })) as typeof fetch });
    expect(full).toMatchObject({ kind: "measured", meter: { rejected: true } });
    const burst = await probeAccount("t", { fetchImpl: (async () => respond(429, {})) as typeof fetch });
    expect(burst).toEqual({ kind: "unmeasured", reason: "briefly rate limited" });
  });

  it("401/403 → refused", async () => {
    const r = await probeAccount("t", { fetchImpl: (async () => respond(401, {}, { error: { message: "invalid token" } })) as typeof fetch });
    expect(r).toEqual({ kind: "refused", reason: "invalid token" });
  });

  it("a missing model tries the next one", async () => {
    const models: string[] = [];
    const r = await probeAccount("t", {
      models: ["gone-model", "live-model"],
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const m = JSON.parse(String(init?.body)).model as string;
        models.push(m);
        return m === "gone-model" ? respond(404, {}, { error: { type: "not_found_error", message: "model: gone" } }) : respond(200, { "5h-utilization": "0" });
      }) as typeof fetch,
    });
    expect(models).toEqual(["gone-model", "live-model"]);
    expect(r.kind).toBe("measured");
  });

  it("a network failure is UNMEASURED, never room and never full", async () => {
    const r = await probeAccount("t", { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(r.kind).toBe("unmeasured");
    expect(standingOf(r, undefined, T).kind).toBe("unmeasured");
  });
});

describe("AccountPool", () => {
  it("reuses a fresh measurement, and a limit mark keeps the account out without probing it", async () => {
    let t = T;
    const probed: string[] = [];
    const probe = async (token: string): Promise<ProbeResult> => {
      probed.push(token);
      return { kind: "measured", meter: meter({ fiveHour: 10, fiveHourReset: T + H, checkedAt: t }) };
    };
    const pool = new AccountPool(file({ accounts: file().accounts.slice(1, 3) }), probe, () => t);
    await pool.measure();
    await pool.measure();
    expect(probed).toEqual(["tok-a", "tok-b"]);
    pool.markFull("a", T + H);
    t += 4 * 60_000;
    await pool.measure();
    expect(probed).toEqual(["tok-a", "tok-b", "tok-b"]);
    expect(pool.select({ design: false }).account?.id).toBe("b");
  });
});

describe("loadAccountsFile", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "worker-accounts-"));
  it("no default file → null (the environment's login, as before)", () => {
    expect(loadAccountsFile(undefined)).toBeNull();
  });
  it("a named file that is missing throws", () => {
    expect(() => loadAccountsFile(path.join(dir(), "nope.json"))).toThrow(/does not exist/);
  });
  it("a broken file throws — never 'no accounts' — and never quotes a token", () => {
    const f = path.join(dir(), "accounts.json");
    fs.writeFileSync(f, '{"version":1,"accounts":[{"id":"a","token":"sk-ant-oat-SECRET"}');
    expect(() => loadAccountsFile(f)).toThrow(/not valid JSON/);
    fs.writeFileSync(f, JSON.stringify({ version: 1, accounts: [{ id: "a b", token: "sk-ant-oat-SECRET" }] }));
    let msg = "";
    try {
      loadAccountsFile(f);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/id must match/);
    expect(msg).not.toContain("SECRET");
  });
  it("reads the documented shape", () => {
    const f = path.join(dir(), "accounts.json");
    fs.writeFileSync(f, JSON.stringify({ version: 1, reserve: 2, accounts: [{ id: "dev", label: "Dev", token: " t1 ", design: true }, { id: "a", token: "t2" }] }));
    expect(loadAccountsFile(f)).toEqual({
      version: 1,
      reserve: 2,
      accounts: [
        { id: "dev", label: "Dev", token: "t1", design: true },
        { id: "a", label: "a", token: "t2" },
      ],
    });
  });
});
