/**
 * `contentKind` (renderer SLOT) vs `viewTypes` (view-renderer AFFINITY) —
 * matching the backend door.
 *
 * The pod's `defineCell` door now REJECTS a cell whose explicit `contentKind`
 * is non-`collection` while `viewTypes` is non-empty. Before this file,
 * `validateStandalonePackage` CERTIFIED that exact pair as valid — its own
 * `VALID_CELL` fixture in `kind-package-cell-codefile.test.ts` used to BE the
 * contradiction (`contentKind: "widget"` + `viewTypes: ["list"]`). An author
 * running `market validate` (green) then publishing would install fine
 * locally and fail on someone else's pod the moment the door's own rejection
 * shipped — a validator certifying what its own publish target refuses.
 *
 * Grep across this repo's templates/skills/fixtures found ZERO instances of
 * the contradictory pair shipped in-repo (confirmed independently here too:
 * `rg -l viewTypes` outside `test/` returns nothing) — blast radius on
 * bundled content is zero; the only real hit was this suite's own fixture.
 */
import { describe, it, expect } from "vitest";
import { validateStandalonePackage, type StandalonePackageFile } from "../src/lib/kind-package.js";

function cellPkg(cell: Record<string, unknown>): StandalonePackageFile {
  return {
    category: "cell",
    slug: "probe-cell",
    displayName: "Probe Cell",
    definition: { cells: [cell] },
  };
}

const BASE = {
  key: "probe-cell",
  name: "Probe Cell",
  code: "export default function Cell() { return null; }",
};

describe("contentKind × viewTypes — matches the door's rejection", () => {
  it("REJECTS an explicit non-collection contentKind paired with non-empty viewTypes, naming both", () => {
    const errors = validateStandalonePackage(
      cellPkg({ ...BASE, contentKind: "widget", viewTypes: ["list", "table"] }),
    );
    const hit = errors.find((e) => e.includes("viewTypes") && e.includes("contentKind"));
    expect(hit, `no combined error in: ${JSON.stringify(errors)}`).toBeTruthy();
    expect(hit).toContain("widget");
    expect(hit).toContain(JSON.stringify(["list", "table"]));
  });

  it("REJECTS the same contradiction for every non-collection contentKind, not just widget", () => {
    for (const contentKind of ["entity-detail", "entity-card", "entity-profile"]) {
      const errors = validateStandalonePackage(
        cellPkg({ ...BASE, contentKind, viewTypes: ["list"] }),
      );
      expect(
        errors.some((e) => e.includes("viewTypes") && e.includes("contentKind")),
        `expected a contradiction error for contentKind="${contentKind}"; got: ${JSON.stringify(errors)}`,
      ).toBe(true);
    }
  });

  it("ACCEPTS contentKind ABSENT with non-empty viewTypes — inference from silence, not a contradiction", () => {
    const errors = validateStandalonePackage(cellPkg({ ...BASE, viewTypes: ["list"] }));
    // contentKind is separately mandatory in THIS validator (a pre-existing,
    // unrelated rule — see kind-package-cell-codefile.test.ts's "rejects a
    // cell missing contentKind"), so the overall result is not clean. What
    // this test pins is narrower and is the actual door-parity claim: the
    // NEW contradiction check must not ALSO fire just because contentKind is
    // silent — the door's own `resolveCellContentKind` infers "collection"
    // from that silence, which is exactly the pairing the rejection targets,
    // not a violation of it.
    expect(errors.some((e) => e.includes("viewTypes") && e.includes("contentKind"))).toBe(
      false,
    );
  });

  it("ACCEPTS contentKind: collection with non-empty viewTypes — the one legal pairing", () => {
    const errors = validateStandalonePackage(
      cellPkg({ ...BASE, contentKind: "collection", viewTypes: ["list"] }),
    );
    expect(errors).toEqual([]);
  });

  it("the existing rule still holds: a collection cell MUST declare viewTypes", () => {
    const errors = validateStandalonePackage(
      cellPkg({ ...BASE, contentKind: "collection" }),
    );
    expect(errors.some((e) => e.includes("viewTypes"))).toBe(true);
  });
});
