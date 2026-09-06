/**
 * `market scaffold --kind cell` must write a cell that is USABLE, not just
 * structurally valid. Verified 2026-09-05: the scaffold's `definition.cells[0]`
 * carried only `{key, name, code}` — no `contentKind`, no `viewTypes`. Both
 * fields are `.optional()` on the CP's `packageDefinitionSchema.cells[]`
 * (synap-control-plane-api/src/routes/packages.ts), so a cell omitting them
 * installs cleanly and then arrives at the pod as the content-agnostic
 * "widget" default with no view-type affinity — permanently unpickable as a
 * renderer, with no error and no signal. See lib/kind-package.ts.
 */
import { describe, it, expect } from "vitest";
import { validateFlowDefinition } from "@synap-core/workspace-templates";
import {
  scaffoldStandalonePackageJson,
  validateStandalonePackage,
} from "../src/lib/kind-package.js";

describe("scaffoldStandalonePackageJson(\"cell\", …)", () => {
  const parsed = JSON.parse(scaffoldStandalonePackageJson("cell", "probe-card-pack"));
  const cell = parsed.definition.cells[0];

  it("declares a contentKind (one of the five CONTENT_KINDS values)", () => {
    expect(["entity-detail", "entity-card", "entity-profile", "collection", "widget"]).toContain(
      cell.contentKind,
    );
  });

  it("declares a non-empty viewTypes[]", () => {
    expect(Array.isArray(cell.viewTypes)).toBe(true);
    expect(cell.viewTypes.length).toBeGreaterThan(0);
  });
});

describe("scaffoldStandalonePackageJson(\"view\", …)", () => {
  it("does not carry cell-only fields (contentKind/viewTypes apply to cells, not views)", () => {
    const parsed = JSON.parse(scaffoldStandalonePackageJson("view", "probe-view-pack"));
    const view = parsed.definition.views[0];
    expect(view.contentKind).toBeUndefined();
    expect(view.viewTypes).toBeUndefined();
  });
});

/**
 * The same "valid but inert" trap the cell assertions above exist for, on the
 * workflow scaffold — and it has two mouths here:
 *
 *  1. `status` — the CP's `automations[]` transform resolves
 *     `defaultStatus ?? status ?? "draft"`, so an automation that omits it
 *     installs as a DRAFT: no error, no signal, never runs. Three flagship
 *     templates already shipped that way.
 *  2. `flowDefinition` — `{nodes: [], edges: []}` passes every shape check and
 *     does nothing. `validateStandalonePackage` only asserts `automations[]` is
 *     non-empty, so nothing else in the CLI would catch it.
 *
 * The flow is asserted against `validateFlowDefinition` — the real node-contract
 * validator, the same one `validateTemplate` runs — rather than a hand-rolled
 * shape check, so this cannot pass on a flow the product would reject.
 */
describe("scaffoldStandalonePackageJson(\"workflow\", …)", () => {
  const parsed = JSON.parse(scaffoldStandalonePackageJson("workflow", "probe-flow-pack"));
  const automation = parsed.definition.automations[0];

  it("carries the identity the CP publish schema names first", () => {
    expect(automation.slug).toBe("probe-flow-pack");
    expect(automation.name).toBeTruthy();
  });

  it("declares status: active (an omitted status installs as an inert draft)", () => {
    expect(automation.status).toBe("active");
  });

  it("does not fire on its own — a scaffolded cron/event would run at install", () => {
    expect(automation.triggerType).toBe("manual");
  });

  it("ships a real flow, not an empty one", () => {
    expect(automation.flowDefinition.nodes.length).toBeGreaterThan(1);
    expect(automation.flowDefinition.edges.length).toBeGreaterThan(0);
  });

  it("passes the node-contract validator (valid node types, output type, edges)", () => {
    const result = validateFlowDefinition(automation.flowDefinition);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

/**
 * `market scaffold --kind capability` — new 2026-09-05. `tools` and `skills`
 * are REQUIRED on `CapabilityDefinition`
 * (synap-backend/packages/playbooks/src/index.ts:845-846), but nothing rejects
 * an EMPTY `skills`: such a capability installs, reports success, and grants
 * the agent nothing. Same "installed but inert" shape as the workflow's absent
 * `status`, which is what the rest of this file exists to pin.
 */
describe("scaffoldStandalonePackageJson(\"capability\", …)", () => {
  const parsed = JSON.parse(
    scaffoldStandalonePackageJson("capability", "probe-method-pack"),
  );
  const cap = parsed.definition.capability;

  it("nests the body under the singular `capability` key the CP unwraps", () => {
    // GET /api/marketplace/capabilities reads `row.definition.capability` and
    // returns null for a row without it — a package using any other key is
    // invisible to the catalog, and therefore to `market install`.
    expect(cap, "definition.capability missing").toBeTruthy();
    expect(parsed.definition.capabilities).toBeUndefined();
  });

  it("carries the identity the catalog card dereferences", () => {
    expect(cap.key).toBe("probe-method-pack");
    expect(typeof cap.name).toBe("string");
    expect(cap.name.length).toBeGreaterThan(0);
  });

  it("grants at least one skill (an empty skills[] installs and does nothing)", () => {
    expect(Array.isArray(cap.skills)).toBe(true);
    expect(cap.skills.length).toBeGreaterThan(0);
    expect(cap.skills[0].code.length, "a skill with empty code teaches nothing")
      .toBeGreaterThan(50);
  });

  it("needs no credential to be usable on a fresh pod", () => {
    // `instruction` = a prompt skill injected into the turn. A `code` skill
    // would need a tool, and a tool would need a vault entry the author has
    // not supplied — a scaffold that cannot run until you find an API key is
    // not usable out of the box.
    expect(cap.skills[0].kind).toBe("instruction");
    expect(cap.tools).toEqual([]);
    expect(cap.vault).toEqual([]);
  });

  it("its own output passes validateStandalonePackage (scaffold → validate)", () => {
    expect(
      validateStandalonePackage({
        category: "capability",
        slug: parsed.slug,
        displayName: parsed.displayName,
        definition: parsed.definition,
      }),
    ).toEqual([]);
  });
});
