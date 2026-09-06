/**
 * Unit tests for the `workflow` standalone-package path (`lib/kind-package`).
 * A `category: "workflow"` file — its payload is `definition.automations[]` — is
 * the shape RC#1 authored for the governance-calibration recommender, and the
 * one the CP `POST /api/packages` door validates (`packageDefinitionSchema`
 * `automations`, category enum `PACKAGE_TYPES` which includes "workflow").
 * These assert the CLI recognises + statically gates it BEFORE the network call.
 */
import { describe, it, expect } from "vitest";
import {
  STANDALONE_KINDS,
  isStandalonePackageFile,
  validateStandalonePackage,
  scaffoldStandalonePackageJson,
  type StandalonePackageFile,
} from "../src/lib/kind-package.js";

// A minimal workflow package (the shape of RC#1's authored file, trimmed).
const WORKFLOW: StandalonePackageFile = {
  category: "workflow",
  slug: "governance-calibration-recommender",
  displayName: "Daily governance calibration",
  description: "Surfaces recommendations once a day.",
  definition: {
    automations: [
      {
        key: "governance-calibration-recommender",
        name: "Daily governance calibration",
        triggerType: "cron",
        triggerConfig: { expression: "0 4 * * *" },
        status: "active",
        flowDefinition: { nodes: [], edges: [] },
      },
    ],
  },
};

describe("STANDALONE_KINDS", () => {
  it("includes workflow (a lone automations[] file is publishable)", () => {
    expect(STANDALONE_KINDS).toContain("workflow");
  });
});

describe("isStandalonePackageFile", () => {
  it("recognises a top-level category: workflow", () => {
    expect(isStandalonePackageFile({ category: "workflow" })).toBe(true);
  });
});

describe("validateStandalonePackage — workflow", () => {
  it("passes a well-formed workflow package", () => {
    expect(validateStandalonePackage(WORKFLOW)).toEqual([]);
  });

  it("rejects a workflow with no automations[]", () => {
    const bad = { ...WORKFLOW, definition: {} };
    const errors = validateStandalonePackage(bad);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/definition\.automations\[\]/);
  });

  it("rejects a workflow with an empty automations[]", () => {
    const bad = { ...WORKFLOW, definition: { automations: [] } };
    expect(validateStandalonePackage(bad)).toHaveLength(1);
  });
});

/**
 * NODE-CONTRACT validation on the standalone lane — wired 2026-09-05.
 *
 * Until then `validateStandalonePackage` checked only that `automations[]` was
 * non-empty, so a semantically broken flow validated GREEN and died at runtime:
 * the automation installs, reports success, and never fires. The workspace lane
 * has run `validateFlowDefinition` at author time since
 * `@synap-core/workspace-templates` validate.ts:655-669; opening
 * `market scaffold --kind workflow` made the standalone lane a first-class
 * authoring path with no such gate. These pin the wiring.
 */
function workflowWithFlow(flow: unknown): StandalonePackageFile {
  return {
    ...WORKFLOW,
    definition: {
      automations: [
        { ...WORKFLOW.definition.automations![0], flowDefinition: flow },
      ],
    },
  } as StandalonePackageFile;
}

describe("validateStandalonePackage — workflow flow contract", () => {
  it("rejects an unknown node type", () => {
    const errs = validateStandalonePackage(
      workflowWithFlow({
        nodes: [{ id: "t", type: "not_a_real_node_type", data: {} }],
        edges: [],
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toMatch(/not_a_real_node_type/);
  });

  it("rejects an edge pointing at a node that does not exist", () => {
    const errs = validateStandalonePackage(
      workflowWithFlow({
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            data: { triggerType: "manual", config: {} },
          },
        ],
        edges: [{ id: "e1", source: "trigger", target: "ghost" }],
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toMatch(/ghost/);
  });

  it("names the automation and the offending node in the message", () => {
    const errs = validateStandalonePackage(
      workflowWithFlow({
        nodes: [{ id: "bad-node", type: "nope", data: {} }],
        edges: [],
      }),
    );
    expect(errs[0]).toContain('automation "Daily governance calibration"');
    expect(errs[0]).toContain('node "bad-node"');
  });

  it("passes the flow `market scaffold --kind workflow` writes", () => {
    const scaffolded = JSON.parse(
      scaffoldStandalonePackageJson("workflow", "probe-flow-pack"),
    );
    expect(
      validateStandalonePackage({
        category: "workflow",
        slug: scaffolded.slug,
        displayName: scaffolded.displayName,
        definition: scaffolded.definition,
      }),
    ).toEqual([]);
  });

  it("leaves a flowless automation alone (absent flow is a shape, not a break)", () => {
    const noFlow = {
      ...WORKFLOW,
      definition: {
        automations: [{ key: "k", name: "N", triggerType: "manual", status: "active" }],
      },
    } as StandalonePackageFile;
    expect(validateStandalonePackage(noFlow)).toEqual([]);
  });
});

describe("validateStandalonePackage — capability", () => {
  const base = {
    category: "capability" as const,
    slug: "probe-cap",
    displayName: "Probe Cap",
  };

  it("rejects a definition with no `capability` key", () => {
    const errs = validateStandalonePackage({ ...base, definition: {} });
    expect(errs.join(" ")).toMatch(/definition\.capability object/);
  });

  it("rejects a capability that grants no skills", () => {
    const errs = validateStandalonePackage({
      ...base,
      definition: { capability: { key: "k", name: "N", tools: [], skills: [] } },
    } as unknown as StandalonePackageFile);
    expect(errs.join(" ")).toMatch(/skills must be a non-empty array/);
  });

  it("accepts a pure know-how capability (tools: [] is legitimate)", () => {
    expect(
      validateStandalonePackage({
        ...base,
        definition: {
          capability: {
            key: "k",
            name: "N",
            tools: [],
            skills: [{ name: "s", kind: "instruction", code: "# s" }],
          },
        },
      } as unknown as StandalonePackageFile),
    ).toEqual([]);
  });
});
