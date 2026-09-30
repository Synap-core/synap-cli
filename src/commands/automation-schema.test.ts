/**
 * Parity test — `synap automation schema` prints exactly the node types the POD
 * declares, and never a list of its own.
 *
 * THE DEFECT (live-dogfooded 2026-09-12, D5): the command printed ten node types
 * and omitted `playbook_run` and `capability`, so an AI authoring a flow from
 * this reference could not emit a playbook step at all. The stale list lived
 * behind the door (the pod's `AUTOMATION_SCHEMA`), and the CLI carried a SECOND
 * one in a fallback branch that fabricated a two-node DSL whenever the door's
 * `nodeTypes` was absent.
 *
 * These assertions are on the RENDERER against a mocked door payload: the
 * printed set must EQUAL the door's set (no additions, no omissions), and an
 * empty read must report itself rather than invent nodes.
 */

import { describe, it, expect } from "vitest";
import { buildSchemaMarkdown } from "./automation.js";

/** The node types the pod's executor accepts (`FLOW_NODE_TYPES`). */
const DOOR_NODE_TYPES = [
  "trigger",
  "command",
  "condition",
  "delay",
  "output",
  "loop",
  "transform",
  "fetch",
  "query",
  "entity_read",
  "related_entities",
  "guard",
  "compute",
  "select",
  "claim",
  "messages_query",
  "runs_query",
  "proposals_query",
  "switch",
  "skill",
  "capability",
  "sub_automation",
  "playbook_run",
];

function doorPayload(names: string[]): Record<string, unknown> {
  return {
    triggerTypes: { manual: { description: "User-triggered." } },
    nodeTypes: Object.fromEntries(
      names.map((n) => [n, { description: `${n} node`, fields: { a: "string" } }])
    ),
  };
}

/** Node headings the renderer emitted, in order. */
function printedNodeTypes(md: string): string[] {
  const body = md.slice(md.indexOf("## Node Types"));
  return [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
}

describe("synap automation schema — the printed node set IS the door's set", () => {
  it("prints every node type the door declares, and only those", () => {
    const md = buildSchemaMarkdown(doorPayload(DOOR_NODE_TYPES), "https://pod.test");
    expect(printedNodeTypes(md)).toEqual(DOOR_NODE_TYPES);
  });

  it("prints the two types the stale hand list omitted", () => {
    const md = buildSchemaMarkdown(doorPayload(DOOR_NODE_TYPES), "https://pod.test");
    // The exact D5 regression: these were absent while the grammar accepted them.
    expect(md).toContain("### playbook_run");
    expect(md).toContain("### capability");
  });

  it("a node type the door ADDS appears with no CLI change", () => {
    // Derivation, not enumeration: an unknown future type must ride through.
    const md = buildSchemaMarkdown(doorPayload(["trigger", "future_node"]), "https://pod.test");
    expect(printedNodeTypes(md)).toEqual(["trigger", "future_node"]);
  });

  it("an EMPTY nodeTypes read is reported, never replaced by a fabricated list", () => {
    const md = buildSchemaMarkdown(
      { triggerTypes: { manual: { description: "x" } } },
      "https://pod.test"
    );
    expect(printedNodeTypes(md)).toEqual([]);
    expect(md).toMatch(/declared no node types/);
  });
});
