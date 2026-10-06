/**
 * `synap orient` renders the pinned space's BUILT brief (pod
 * `services/discover/space-brief.ts`). Driven with the wire shape the pod
 * emits, including the two shapes this CLI used to mishandle:
 *   - W3's steady-state fields (anchors, rule keys) must reach the lines;
 *   - a playbook list the pod SHED to fit its byte cap (`items: []`, or an
 *     older/newer pod omitting `items`) must still show the true count and
 *     never throw.
 */
import { describe, it, expect } from "vitest";
import { renderSpaceBriefLines } from "../src/commands/data.js";

describe("renderSpaceBriefLines", () => {
  it("renders the root anchor, context kinds and rule keys", () => {
    const lines = renderSpaceBriefLines({
      purpose: "The brand's source of truth.",
      anchors: {
        root: { kind: "brand-identity", entityId: "e-1" },
        context: ["brand-rule", "brand-voice-guide"],
      },
      rules: ["brand-store-typed"],
    });
    expect(lines).toContain("read first: brand-identity e-1");
    expect(lines).toContain("context: brand-rule, brand-voice-guide");
    expect(lines).toContain("rules: brand-store-typed");
  });

  it("a shed playbook list shows the true count", () => {
    expect(
      renderSpaceBriefLines({ playbooks: { items: [], total: 5 } })
    ).toContain("playbooks: 5");
    expect(renderSpaceBriefLines({ playbooks: { total: 3 } })).toContain(
      "playbooks: 3"
    );
  });

  it("a listed playbook keeps its names and the overflow", () => {
    expect(
      renderSpaceBriefLines({
        playbooks: { items: [{ id: "p1", name: "Build the kit" }], total: 2 },
      })
    ).toContain("playbooks: Build the kit …+1");
  });

  it("renders the space's declared skills WITH their mode", () => {
    // `always` is the load-bearing mark — that skill is already in effect here,
    // which is what a reader needs to know at a glance.
    const lines = renderSpaceBriefLines({
      skills: [
        {
          slug: "system/synap/creative-director",
          mode: "always",
          when: "any content ask",
        },
        { slug: "system/synap/onboard", mode: "on-demand" },
      ],
    });
    expect(lines).toContain(
      "skills: system/synap/creative-director (always), system/synap/onboard (on-demand)"
    );
  });

  it("a space with no declared skills adds no line (and never throws)", () => {
    const lines = renderSpaceBriefLines({ purpose: "p" });
    expect(lines.some((l) => l.startsWith("skills:"))).toBe(false);
  });
});
