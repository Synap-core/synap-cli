/**
 * Shape tripwire for the bundled bookmark automation templates.
 *
 * These files are DATA — nothing typechecks them, and `bridge-setup.ts` seeds
 * them verbatim over the Hub REST door whose `FlowDefinitionSchema` accepts
 * `z.record(z.string(), z.unknown())` nodes. So a typo in a node type or in a
 * `{{...}}` scope path is invisible until a run silently interpolates "" — the
 * exact failure mode that produced the bare-bookmark bug. This pins the SHAPE:
 * node ids + types, the deterministic-before-AI ordering, and every
 * interpolation scope path the enrichment flow depends on.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const templatesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "automations"
);

type Node = { id: string; type: string; data: Record<string, unknown> };
type Edge = { id: string; source: string; target: string; sourceHandle?: string };
type Template = {
  name: string;
  triggerType: string;
  flowDefinition: { nodes: Node[]; edges: Edge[] };
};

function load(file: string): Template {
  return JSON.parse(
    fs.readFileSync(path.join(templatesDir, file), "utf-8")
  ) as Template;
}

/**
 * Every `{{path}}` occurrence in the FLOW — deliberately not the whole file.
 * `metadata.note` is prose and may quote a `{{…}}` placeholder; only the flow
 * is what the executor resolves.
 */
function interpolations(tpl: Template): string[] {
  const found =
    JSON.stringify(tpl.flowDefinition).match(/\{\{([^{}]+)\}\}/g) ?? [];
  return [...new Set(found.map((m) => m.slice(2, -2).trim()))];
}

/** Node ids in topological (execution) order — the executor's own Kahn sort. */
function topoOrder(tpl: Template): string[] {
  const { nodes, edges } = tpl.flowDefinition;
  const inDegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  const queue = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of edges.filter((x) => x.source === id)) {
      const d = (inDegree.get(e.target) ?? 1) - 1;
      inDegree.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  return order;
}

// Node types the automation executor actually dispatches
// (synap-backend/packages/jobs/src/workers/automation-executor.ts).
const KNOWN_NODE_TYPES = new Set([
  "trigger", "command", "condition", "delay", "output", "loop", "transform",
  "fetch", "query", "entity_read", "related_entities", "guard", "compute",
  "select", "claim", "messages_query", "runs_query", "proposals_query",
  "switch", "skill", "capability", "sub_automation", "playbook_run",
]);

// Root scopes `lookupContextPath` can resolve (workers/context-path.ts +
// the StepContext the executor builds). Anything else silently yields "".
const KNOWN_SCOPES = new Set(["trigger", "steps", "loop", "item", "automation"]);

describe.each(fs.readdirSync(templatesDir).filter((f) => f.endsWith(".automation.json")))(
  "%s — structural invariants",
  (file) => {
    const tpl = load(file);

    it("every node type is one the executor dispatches", () => {
      for (const node of tpl.flowDefinition.nodes) {
        expect(KNOWN_NODE_TYPES, `${node.id}: unknown node type "${node.type}"`)
          .toContain(node.type);
      }
    });

    it("every edge endpoint names a real node", () => {
      const ids = new Set(tpl.flowDefinition.nodes.map((n) => n.id));
      for (const e of tpl.flowDefinition.edges) {
        expect(ids, `edge ${e.id}.source`).toContain(e.source);
        expect(ids, `edge ${e.id}.target`).toContain(e.target);
      }
    });

    it("every {{…}} reference uses a resolvable root scope and a real step id", () => {
      const ids = new Set(tpl.flowDefinition.nodes.map((n) => n.id));
      for (const ref of interpolations(tpl)) {
        const [root, second] = ref.split(".");
        expect(KNOWN_SCOPES, `"${ref}" — unknown root scope`).toContain(root);
        if (root === "steps") {
          expect(ids, `"${ref}" — no such node id`).toContain(second);
        }
      }
    });

    it("a step reference only points at a node that runs BEFORE it", () => {
      const order = topoOrder(tpl);
      expect(order.length).toBe(tpl.flowDefinition.nodes.length); // no cycle
      for (const node of tpl.flowDefinition.nodes) {
        const here = order.indexOf(node.id);
        const refs = (JSON.stringify(node.data).match(/\{\{steps\.([^.{}]+)\./g) ?? [])
          .map((m) => m.slice("{{steps.".length, -1));
        for (const dep of refs) {
          expect(
            order.indexOf(dep),
            `${node.id} reads steps.${dep} which does not run before it`
          ).toBeLessThan(here);
        }
      }
    });
  }
);

describe("bookmark-enrichment — deterministic resolution runs BEFORE the AI", () => {
  const tpl = load("bookmark-enrichment.automation.json");
  const order = topoOrder(tpl);
  const at = (id: string) => order.indexOf(id);
  const node = (id: string) =>
    tpl.flowDefinition.nodes.find((n) => n.id === id)!;

  it("has exactly one AI node, and it is a capability/ai.generate step", () => {
    const ai = tpl.flowDefinition.nodes.filter(
      (n) => n.type === "capability" || n.type === "skill" || n.type === "command"
    );
    expect(ai.map((n) => n.id)).toEqual(["classify"]);
    expect(ai[0].data.verbId).toBe("ai.generate");
  });

  it("makes NO network fetch — a page fetch is deliberately absent", () => {
    expect(tpl.flowDefinition.nodes.map((n) => n.type)).not.toContain("fetch");
  });

  it("runs every deterministic context step before the AI step", () => {
    for (const id of ["read", "graph-context", "channel-talk", "sharer-lookup"]) {
      expect(node(id)).toBeDefined();
      expect(at(id), `${id} must precede classify`).toBeLessThan(at("classify"));
    }
  });

  // SPLIT WRITE (founder decision, 2026-08-19). The AI call is NO LONGER gated
  // behind the title checks — description + category are wanted on every
  // bookmark, and gating the whole call meant a well-titled link got neither.
  // What the title checks gate now is only the TITLE WRITE, so a human-written
  // name is never overwritten by a model guess.
  it("description + category are written unconditionally", () => {
    const enrich = node("apply-enrich");
    expect(enrich.data.outputType).toBe("entity_update");
    const cfg = enrich.data.config as Record<string, unknown>;
    // `description` is a declared bookmark PROPERTY, not an entities column —
    // `schema/entities.ts` has title/preview/properties and NO description.
    // It was written as a top-level column once and silently vanished: the step
    // spreads it into `UpdateEntityInput`, and object SPREAD bypasses
    // TypeScript's excess-property check, so tsc stayed green while the field
    // was dropped. Pin its real home.
    const props = cfg.properties as Record<string, unknown>;
    expect(
      cfg.description,
      "description is not an entities column — writing it here is silently dropped"
    ).toBeUndefined();
    expect(props.description).toContain("steps.classify.output.description");
    expect(props.category).toContain("steps.classify.output.category");
    // Reached straight off the AI node — no condition in between.
    expect(
      tpl.flowDefinition.edges.some(
        (e) => e.source === "classify" && e.target === "apply-enrich"
      ),
      "apply-enrich must hang directly off classify, or it stops being unconditional"
    ).toBe(true);
    // ...and it must NOT write the title, or the gate below is pointless.
    expect(cfg.title, "apply-enrich must never write the title").toBeUndefined();
  });

  it("the TITLE write is gated behind both title conditions and the guard", () => {
    for (const id of ["title-present", "title-not-url"]) {
      expect(node(id).type).toBe("condition");
      // They now run AFTER the AI, deciding whether to keep its title.
      expect(at(id)).toBeGreaterThan(at("classify"));
    }
    expect(node("usable-title").type).toBe("guard");
    expect(at("usable-title")).toBeLessThan(at("apply-title"));
    // The title write is reached only from the FALSE arms of both checks.
    const intoGuard = tpl.flowDefinition.edges.filter(
      (e) => e.target === "usable-title"
    );
    expect(
      intoGuard.map((e) => `${e.source}:${e.sourceHandle}`).sort()
    ).toEqual(["title-not-url:no", "title-present:no"]);
    const cfg = node("apply-title").data.config as Record<string, unknown>;
    // `title` has TWO homes — the entities column and a declared bookmark
    // property. Write both or `synap show` keeps rendering the stale raw URL.
    expect(cfg.title).toContain("steps.classify.output.title");
    expect(
      (cfg.properties as Record<string, unknown>).title,
      "properties.title must be written too, or it diverges from the column"
    ).toContain("steps.classify.output.title");
  });

  it("a good captured title dead-ends — nothing overwrites it", () => {
    const yes = tpl.flowDefinition.edges.filter(
      (e) => e.source === "title-not-url" && e.sourceHandle === "yes"
    );
    expect(
      yes,
      "title-not-url:yes must lead nowhere — that arm means the captured name is good"
    ).toEqual([]);
  });

  it("the person lookup uses the STRING filter form", () => {
    // parseQueryFilterConditions (workers/query-dsl.ts) template-resolves a
    // STRING filter but pushes an OBJECT filter's values RAW — the object form
    // would compare the literal "{{…}}" text and match nothing, silently.
    const q = node("sharer-lookup");
    expect(q.type).toBe("query");
    expect(typeof q.data.filter).toBe("string");
    expect(q.data.filter as string).toContain(
      "{{steps.read.output.entity.properties.sharedBy}}"
    );
  });

  it("links the sharer with an EXISTING relation def, not an invented slug", () => {
    // relations.create rejects a type that is neither a system/impact built-in
    // nor a workspace relation def (packages/api/src/routers/relations.ts).
    const DEFAULT_RELATION_SLUGS = new Set([
      "assigned_to", "blocks", "depends_on", "relates_to", "mentions",
      "links_to", "parent_of", "tagged_with", "created_by", "attended_by",
      "belongs_to_project", "founder_brand_of", "references", "works_at",
      "deal_for", "advances", "met_at", "works_on", "has_skill",
      "affiliated_with", "knows", "discussed_with",
    ]);
    for (const n of tpl.flowDefinition.nodes) {
      if (n.data.outputType !== "relation_create") continue;
      const type = (n.data.config as { relationType: string }).relationType;
      expect(DEFAULT_RELATION_SLUGS, `${n.id}: "${type}"`).toContain(type);
    }
  });

  it("reads only properties the capture template actually writes", () => {
    const capture = load("url-bookmark-capture.automation.json");
    const written = new Set(
      Object.keys(
        (capture.flowDefinition.nodes.find((n) => n.id === "create-bookmark")!
          .data.config as { properties: Record<string, unknown> }).properties
      )
    );
    const read = interpolations(tpl)
      .filter((r) => r.startsWith("steps.read.output.entity.properties."))
      .map((r) => r.slice("steps.read.output.entity.properties.".length));
    for (const key of read) {
      expect(written, `enrichment reads "${key}" which capture never writes`)
        .toContain(key);
    }
  });
});

/**
 * Two gaps the shape tests above cannot close on their own.
 *
 * 1. NON-VACUITY. Most assertions here are `for (const x of collection)`, which
 *    passes trivially when the collection is empty. Strip the template to zero
 *    nodes and the suite still goes green. Today's dogfood produced the exact
 *    same shape one layer up: a tripwire that scanned 25 real files, passed, and
 *    was still blind to the break. Pin the floors.
 *
 * 2. DERIVED, NOT HAND-TYPED. `KNOWN_NODE_TYPES` above is a hand-maintained Set.
 *    If the executor renames or drops a node type, that Set silently keeps
 *    asserting against a contract that no longer exists — a green test over a
 *    dead dispatch. Rather than re-deriving the whole executor table (a naive
 *    `case "x":` scan picks up unrelated switches — a duration parser
 *    contributes "d"/"h"/"ms"/"s"/"w"), check only the types this template
 *    ACTUALLY uses. Narrower, and immune to that noise.
 */
describe("the shape tests above are non-vacuous", () => {
  const tpl = load("bookmark-enrichment.automation.json");

  it("the enrichment template still has its full node/edge set", () => {
    expect(tpl.flowDefinition.nodes.length).toBeGreaterThanOrEqual(13);
    expect(tpl.flowDefinition.edges.length).toBeGreaterThanOrEqual(15);
  });

  it("there are interpolations to validate", () => {
    expect(
      interpolations(tpl).length,
      "no {{...}} refs found — every interpolation assertion above is vacuous"
    ).toBeGreaterThanOrEqual(8);
  });

  it("deterministic resolution still precedes the AI call", () => {
    const order = topoOrder(tpl);
    const ai = order.indexOf("classify");
    expect(ai, "the AI node vanished — this template's whole point is that it is LAST").toBeGreaterThan(-1);
    for (const det of ["graph-context", "channel-talk", "sharer-lookup"]) {
      expect(
        order.indexOf(det),
        `${det} must run BEFORE the AI fallback, not after`
      ).toBeLessThan(ai);
    }
  });
});

describe("node types are dispatched by the real executor", () => {
  // Cross-repo: synap-backend sits beside synap-cli in the monorepo.
  const EXECUTOR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../synap-backend/packages/jobs/src/workers/automation-executor.ts"
  );
  const available = fs.existsSync(EXECUTOR);

  it("can see the executor it validates against", () => {
    expect(
      available,
      `Cannot find ${EXECUTOR}. This check proves the template's node types are ` +
        `actually dispatched; it needs synap-backend checked out beside synap-cli. ` +
        `Clone it there — do not delete this test.`
    ).toBe(true);
  });

  if (available) {
    const src = fs.readFileSync(EXECUTOR, "utf8");
    const tpl = load("bookmark-enrichment.automation.json");
    // `trigger` is the flow's ENTRY POINT, not a dispatched step: the executor
    // skips it outright (`if (node.type === "trigger") continue;`,
    // automation-executor.ts:679) and seeds it as a pre-satisfied dependency
    // (:587). So it legitimately has no `case "trigger":` and must be excluded
    // — verified by reading the executor, not assumed to make this test pass.
    const NOT_DISPATCHED_BY_DESIGN = new Set(["trigger"]);
    const used = [...new Set(tpl.flowDefinition.nodes.map((n) => n.type))].filter(
      (t) => !NOT_DISPATCHED_BY_DESIGN.has(t)
    );

    it("the trigger really is skipped rather than dispatched", () => {
      expect(
        /if \(node\.type === "trigger"\) continue;/.test(src),
        "the executor no longer skips trigger nodes — re-check whether trigger " +
          "now needs a dispatch case before trusting the exclusion above"
      ).toBe(true);
    });

    it("is non-vacuous: the template declares node types to check", () => {
      expect(used.length).toBeGreaterThanOrEqual(6);
    });

    for (const type of used) {
      it(`executor dispatches "${type}"`, () => {
        expect(
          new RegExp(`case\\s+"${type}"\\s*:`).test(src),
          `automation-executor.ts has no \`case "${type}":\` — this node would ` +
            `fall through and the step would silently do nothing`
        ).toBe(true);
      });
    }
  }
});
