/**
 * `synap doctor`'s key check never tells the person to run `synap doctor`
 * (review bf96d410, lane D): the map's fallback next step is "Run `synap
 * doctor`", right for every other command and circular here. A 5xx gets
 * "the pod is not answering, try again"; any other refusal the line alone.
 */
import { describe, expect, it } from "vitest";
import { doctorFixOf } from "../src/commands/doctor.js";
import { explainPodError } from "../src/lib/pod-errors.js";

const POD = "https://pod.doctor.synap.live";

function fixFor(status: number, body?: unknown): string {
  return doctorFixOf(explainPodError({ status, body: body === undefined ? undefined : JSON.stringify(body), podUrl: POD }), status);
}

describe("synap doctor's fix line for a refused key check", () => {
  it("never advises running synap doctor, for any status but 401", () => {
    for (const status of [400, 403, 404, 409, 429, 500, 502, 503]) {
      expect(fixFor(status, { error: "Something" })).not.toMatch(/synap doctor/);
    }
  });

  it("a 5xx: the pod is not answering, try again, pod admin; nothing of the body", () => {
    const fix = fixFor(503, { error: "upstream connect error" });
    expect(fix).toBe("Try again in a minute, or check pod admin (https://pod-admin.doctor.synap.live).");
  });

  it("any other refusal: the map's line alone", () => {
    expect(fixFor(404, { error: "No such route" })).toBe("The pod refused (HTTP 404): No such route");
  });
});
