import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rule,
  ruleList,
  ClassifyDoorMissingError,
  MissingScopeError,
  type IntentRoute,
  type RuleDeps,
  type RuleRow,
} from "../src/commands/rule.js";
import type { HubConfig } from "../src/lib/hub-client.js";

const CFG: HubConfig = {
  podUrl: "https://pod.example",
  apiKey: "test-key",
  userId: "user-1",
  workspaceId: "11111111-1111-1111-1111-111111111111",
};

/**
 * The three terminal classifier states, per
 * `services/knowledge/classify-intent.ts`:
 *  - classified: shapes + no needsClarification
 *  - one-shot:   primary "unknown", oneShot true, NO needsClarification
 *  - ambiguous:  primary "unknown", oneShot false, WITH needsClarification
 * `shapes` is never empty in any of them.
 */
const CLASSIFIED: IntentRoute = {
  shapes: [
    { shape: "behaviour", confidence: 0.72, cues: ["when a", "external source"] },
    { shape: "structure", confidence: 0.31, cues: ["one folder per client"] },
  ],
  primary: "behaviour",
  oneShot: false,
};

const ONE_SHOT: IntentRoute = {
  shapes: [{ shape: "unknown", confidence: 0, cues: ["we're working on", "research the"] }],
  primary: "unknown",
  oneShot: true,
};

const AMBIGUOUS: IntentRoute = {
  shapes: [{ shape: "unknown", confidence: 0, cues: [] }],
  primary: "unknown",
  oneShot: false,
  needsClarification: {
    reason: "could be a fact about Acme or a routing rule for Acme's mail",
    question: "Should this describe Acme, or change what happens to Acme's mail?",
  },
};

function makeDeps(over: Partial<RuleDeps> = {}): RuleDeps {
  return {
    classify: vi.fn().mockResolvedValue(CLASSIFIED),
    create: vi.fn().mockResolvedValue({ status: "created", ruleId: "rule-1" }),
    list: vi.fn().mockResolvedValue([]),
    config: vi.fn().mockResolvedValue(CFG),
    confirm: vi.fn().mockResolvedValue(false),
    ...over,
  };
}

/**
 * The CLI keeps diagnostics on stderr and DATA on stdout on purpose (see
 * `utils/logger.ts`) — so `synap rule --json | jq` works even when a warning
 * fired. The harness keeps the two apart for the same reason: a `--json` test
 * that parses a merged stream would pass while the real pipe was broken.
 */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    err.push(a.join(" "));
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  return {
    exit,
    /** stdout only — what a `--json` consumer actually parses. */
    stdout: () => out.join("\n"),
    /** Everything a human sees. */
    text: () => [...out, ...err].join("\n"),
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exit.mockRestore();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("synap rule — a ONE-SHOT ask is never silently made permanent", () => {
  it("refuses to write, and offers to run it once instead", async () => {
    const deps = makeDeps({ classify: vi.fn().mockResolvedValue(ONE_SHOT) });
    const c = capture();

    await rule(
      "we're working on Stellar Grants — research the process and map the deadlines",
      {},
      deps
    );

    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(c.text()).toMatch(/ONE-OFF request, not a standing rule/);
    expect(c.text()).toMatch(/No rule created/);
    // The cues that produced the verdict are shown, not just the verdict.
    expect(c.text()).toContain("we're working on");
    c.restore();
  });

  it("writes only after an explicit confirmation", async () => {
    const deps = makeDeps({
      classify: vi.fn().mockResolvedValue(ONE_SHOT),
      confirm: vi.fn().mockResolvedValue(true),
    });
    const c = capture();

    await rule("research the Stellar process", {}, deps);

    expect(deps.create).toHaveBeenCalledOnce();
    c.restore();
  });

  it("--yes skips the confirmation and writes", async () => {
    const deps = makeDeps({ classify: vi.fn().mockResolvedValue(ONE_SHOT) });
    const c = capture();

    await rule("research the Stellar process", { yes: true }, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.create).toHaveBeenCalledOnce();
    c.restore();
  });

  it("--json (no --yes) cannot prompt, so it refuses and exits 1", async () => {
    const deps = makeDeps({ classify: vi.fn().mockResolvedValue(ONE_SHOT) });
    const c = capture();

    await rule("research the Stellar process", { json: true }, deps);

    expect(deps.create).not.toHaveBeenCalled();
    expect(c.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(c.stdout()).outcome).toBe("one-shot-refused");
    c.restore();
  });
});

describe("synap rule — needsClarification exits without writing", () => {
  it("prints the specific ambiguity and does not guess", async () => {
    const deps = makeDeps({ classify: vi.fn().mockResolvedValue(AMBIGUOUS) });
    const c = capture();

    await rule("acme mail", {}, deps);

    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(c.exit).toHaveBeenCalledWith(1);
    expect(c.text()).toContain(AMBIGUOUS.needsClarification!.reason);
    expect(c.text()).toContain(AMBIGUOUS.needsClarification!.question);
    c.restore();
  });

  it("--yes does NOT override a clarification — skipping a prompt is not an answer", async () => {
    const deps = makeDeps({ classify: vi.fn().mockResolvedValue(AMBIGUOUS) });
    const c = capture();

    await rule("acme mail", { yes: true }, deps);

    expect(deps.create).not.toHaveBeenCalled();
    expect(c.exit).toHaveBeenCalledWith(1);
    c.restore();
  });

  it("--json emits parseable needs-clarification output", async () => {
    const deps = makeDeps({ classify: vi.fn().mockResolvedValue(AMBIGUOUS) });
    const c = capture();

    await rule("acme mail", { json: true }, deps);

    const parsed = JSON.parse(c.stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.outcome).toBe("needs-clarification");
    expect(parsed.route.needsClarification.question).toBe(
      AMBIGUOUS.needsClarification!.question
    );
    c.restore();
  });
});

describe("synap rule — fail-closed when the pod has no classifier door", () => {
  it("refuses to write a rule it could not read, and blames the POD not the sentence", async () => {
    const deps = makeDeps({
      classify: vi
        .fn()
        .mockRejectedValue(new ClassifyDoorMissingError("POST /api/hub/rules/classify")),
    });
    const c = capture();

    await rule("always tag Acme invoices urgent", {}, deps);

    expect(deps.create).not.toHaveBeenCalled();
    expect(c.exit).toHaveBeenCalledWith(1);
    // Asserts the USER-FACING sentence, not an internal component name: the
    // message must say what the reader can act on. The route still appears
    // (parenthesised) for whoever deploys the pod.
    expect(c.text()).toMatch(/can't read rules yet/i);
    expect(c.text()).toMatch(/api\/hub\/rules\/classify/);
    expect(c.text()).toMatch(/your POD's build, not your sentence/);
    c.restore();
  });

  it("--json distinguishes an old pod from an ambiguous sentence", async () => {
    const deps = makeDeps({
      classify: vi
        .fn()
        .mockRejectedValue(new ClassifyDoorMissingError("POST /api/hub/rules/classify")),
    });
    const c = capture();

    await rule("always tag Acme invoices urgent", { json: true }, deps);

    expect(JSON.parse(c.stdout()).outcome).toBe("classify-door-missing");
    c.restore();
  });
});

describe("synap rule — a governed `proposed` result is queued, never failed", () => {
  it("reports it as queued for review with the proposal id and how to review it", async () => {
    const deps = makeDeps({
      create: vi.fn().mockResolvedValue({ status: "proposed", proposalId: "prop-42" }),
    });
    const c = capture();

    await rule("always tag Acme invoices urgent", {}, deps);

    const text = c.text();
    expect(c.exit).not.toHaveBeenCalled();
    expect(text).toMatch(/queued for your review/);
    expect(text).toContain("prop-42");
    expect(text).toContain("synap open proposal prop-42");
    // Never rendered as an error.
    expect(text).not.toMatch(/✗/);
    c.restore();
  });

  it("--json marks it ok:true with outcome proposed", async () => {
    const deps = makeDeps({
      create: vi.fn().mockResolvedValue({ status: "proposed", proposalId: "prop-42" }),
    });
    const c = capture();

    await rule("always tag Acme invoices urgent", { json: true }, deps);

    const parsed = JSON.parse(c.stdout());
    expect(parsed.ok).toBe(true);
    expect(parsed.outcome).toBe("proposed");
    expect(parsed.proposalId).toBe("prop-42");
    expect(c.exit).not.toHaveBeenCalled();
    c.restore();
  });

  it("is honest that no behaviour is attached — this door records the rule only", async () => {
    const deps = makeDeps();
    const c = capture();

    await rule("always tag Acme invoices urgent", {}, deps);

    expect(c.text()).toMatch(/No behaviour attached yet/);
    c.restore();
  });

  it("--json reports behaviourAttached:false rather than implying a full rule", async () => {
    const deps = makeDeps();
    const c = capture();

    await rule("always tag Acme invoices urgent", { json: true }, deps);

    expect(JSON.parse(c.stdout()).behaviourAttached).toBe(false);
    c.restore();
  });
});

describe("synap rule — the reading is shown before anything is written", () => {
  it("prints every shape, its confidence, and the cues that fired", async () => {
    const deps = makeDeps();
    const c = capture();

    await rule("when a new file appears, file it per client", {}, deps);

    const text = c.text();
    expect(text).toContain("behaviour");
    expect(text).toContain("0.72");
    expect(text).toContain("because: when a, external source");
    expect(text).toContain("structure");
    expect(text).toContain("one folder per client");
    c.restore();
  });

  it("scopes to the active workspace, and --pod-wide overrides it", async () => {
    const withWs = makeDeps();
    const c1 = capture();
    await rule("a rule", {}, withWs);
    expect(withWs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "workspace", workspaceId: CFG.workspaceId },
      }),
      CFG
    );
    c1.restore();

    const podWide = makeDeps();
    const c2 = capture();
    await rule("a rule", { podWide: true }, podWide);
    expect(podWide.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "pod" } }),
      CFG
    );
    c2.restore();
  });

  it("rejects an empty rule before touching the pod", async () => {
    const deps = makeDeps();
    const c = capture();

    await rule("   ", {}, deps);

    expect(deps.config).not.toHaveBeenCalled();
    expect(deps.classify).not.toHaveBeenCalled();
    expect(c.exit).toHaveBeenCalledWith(1);
    c.restore();
  });
});

describe("synap rule list", () => {
  const ROWS: RuleRow[] = [
    {
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      name: "Tag Acme invoices",
      approved: true,
      rule: {
        intent: "always tag Acme invoices urgent",
        scope: { kind: "pod" },
        trust: "propose",
        behaviours: [{ automationId: "auto-1" }],
      },
    },
    {
      id: "bbbbbbbb-0000-0000-0000-000000000000",
      name: "Webinar prospects",
      approved: false,
      rule: {
        intent: "people from the webinar list are prospects",
        scope: { kind: "workspace", workspaceId: CFG.workspaceId! },
        trust: "propose",
        behaviours: [],
      },
    },
  ];

  it("shows each rule's intent, scope, and whether a behaviour is attached", async () => {
    const deps = makeDeps({ list: vi.fn().mockResolvedValue(ROWS) });
    const c = capture();

    await ruleList({}, deps);

    const text = c.text();
    expect(text).toContain("always tag Acme invoices urgent");
    expect(text).toContain("1 automation");
    expect(text).toContain("no behaviour");
    expect(text).toContain("pod");
    c.restore();
  });

  it("--json emits parseable rows carrying behaviourAttached", async () => {
    const deps = makeDeps({ list: vi.fn().mockResolvedValue(ROWS) });
    const c = capture();

    await ruleList({ json: true }, deps);

    const parsed = JSON.parse(c.stdout());
    expect(parsed.count).toBe(2);
    expect(parsed.rules[0].behaviourAttached).toBe(true);
    expect(parsed.rules[1].behaviourAttached).toBe(false);
    expect(parsed.rules[1].approved).toBe(false);
    c.restore();
  });

  it("an empty list points at the door that creates one", async () => {
    const deps = makeDeps();
    const c = capture();

    await ruleList({}, deps);

    expect(c.text()).toMatch(/none yet/);
    expect(c.text()).toMatch(/synap rule "<your rule>"/);
    c.restore();
  });
});

describe("synap rule — three refusal causes stay tellable apart", () => {
  it("a missing Bearer scope blames the KEY, not the pod and not the sentence", async () => {
    const deps = makeDeps({
      classify: vi.fn().mockRejectedValue(new MissingScopeError("hub-protocol.read")),
    });
    const c = capture();

    await rule("always tag Acme invoices urgent", {}, deps);

    expect(deps.create).not.toHaveBeenCalled();
    expect(c.exit).toHaveBeenCalledWith(1);
    expect(c.text()).toMatch(/lacks the `hub-protocol.read` scope/);
    expect(c.text()).toMatch(/your API KEY, not your pod or your sentence/);
    // Must NOT be mistaken for an old pod.
    expect(c.text()).not.toMatch(/update the pod/);
    c.restore();
  });

  it("--json names each of the three causes distinctly", async () => {
    const cause = async (classify: RuleDeps["classify"]) => {
      const c = capture();
      await rule("x", { json: true }, makeDeps({ classify }));
      const outcome = JSON.parse(c.stdout()).outcome;
      c.restore();
      return outcome;
    };

    expect(
      await cause(vi.fn().mockRejectedValue(new ClassifyDoorMissingError("POST /api/hub/rules/classify")))
    ).toBe("classify-door-missing");
    expect(await cause(vi.fn().mockRejectedValue(new MissingScopeError("hub-protocol.read")))).toBe(
      "missing-scope"
    );
    expect(await cause(vi.fn().mockResolvedValue(AMBIGUOUS))).toBe("needs-clarification");
  });

  it("a governance DENIAL is reported with its reason and exits 1", async () => {
    const deps = makeDeps({
      create: vi
        .fn()
        .mockResolvedValue({ status: "denied", reason: "rules are admin-only in this workspace" }),
    });
    const c = capture();

    await rule("always tag Acme invoices urgent", {}, deps);

    expect(c.exit).toHaveBeenCalledWith(1);
    expect(c.text()).toMatch(/Rule refused: rules are admin-only in this workspace/);
    c.restore();
  });

  it("a null `approved` on the wire renders as awaiting review, not approved", async () => {
    const deps = makeDeps({
      list: vi.fn().mockResolvedValue([
        {
          id: "cccccccc-0000-0000-0000-000000000000",
          name: "n",
          approved: null,
          rule: { intent: "a rule", scope: { kind: "pod" }, behaviours: [] },
        },
      ] as unknown as RuleRow[]),
    });
    const c = capture();

    await ruleList({}, deps);

    expect(c.text()).toContain("○");
    expect(c.text()).not.toContain("●  a rule");
    c.restore();
  });
});

/**
 * A rule that exists ONLY as a pending proposal. `synap rule list` returned 0
 * straight after `synap rule "…"` proposed one — so the next reader (human or
 * agent) could not see it and proposed the same rule again. The listing now
 * asks the door for proposed rules and renders them as the third state they
 * are: not written yet.
 */
describe("synap rule list — a proposed rule is visible and unmistakable", () => {
  const PROPOSED: RuleRow[] = [
    {
      id: "dddddddd-0000-0000-0000-000000000000",
      name: "CC me on invoices",
      approved: false,
      status: "proposed",
      proposalId: "eeeeeeee-1111-2222-3333-444444444444",
      rule: {
        intent: "always CC me on invoices",
        scope: { kind: "pod" },
        trust: "propose",
        behaviours: [],
      },
    },
    {
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      name: "Tag Acme invoices",
      approved: true,
      status: "active",
      rule: {
        intent: "always tag Acme invoices urgent",
        scope: { kind: "pod" },
        trust: "propose",
        behaviours: [{ automationId: "auto-1" }],
      },
    },
  ];

  it("marks a proposed rule apart from an approved one and from one merely awaiting review", async () => {
    const deps = makeDeps({ list: vi.fn().mockResolvedValue(PROPOSED) });
    const c = capture();

    await ruleList({}, deps);

    const text = c.text();
    expect(text).toContain("always CC me on invoices");
    // Its own badge — not the "○ awaiting review" an unapproved REAL row gets.
    expect(text).toContain("◇");
    expect(text).toMatch(/proposed — not written yet/);
    // The only id that opens anything for a proposed rule.
    expect(text).toContain("proposal eeeeeeee…");
    // The approved row is untouched.
    expect(text).toContain("●");
    c.restore();
  });

  it("--json carries status + proposalId, and defaults a status-less pod to active", async () => {
    const deps = makeDeps({
      list: vi.fn().mockResolvedValue([
        ...PROPOSED,
        {
          id: "ffffffff-0000-0000-0000-000000000000",
          name: "legacy",
          approved: true,
          rule: { intent: "an older pod sends no status", scope: { kind: "pod" }, behaviours: [] },
        },
      ] as unknown as RuleRow[]),
    });
    const c = capture();

    await ruleList({ json: true }, deps);

    const parsed = JSON.parse(c.stdout());
    expect(parsed.rules[0].status).toBe("proposed");
    expect(parsed.rules[0].proposalId).toBe("eeeeeeee-1111-2222-3333-444444444444");
    expect(parsed.rules[1].status).toBe("active");
    expect(parsed.rules[1].proposalId).toBeUndefined();
    expect(parsed.rules[2].status).toBe("active");
    c.restore();
  });
});
