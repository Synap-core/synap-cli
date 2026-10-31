/**
 * `podAdminOrigin` must follow the one console-naming rule (`consoleHostForPod`,
 * `@synap-core/types/tenancy`). It once stripped the first label, so a current
 * cloud pod `sillage.pod.synap.live` got `pod-admin.pod.synap.live` instead of
 * `admin.sillage.pod.synap.live`.
 */
import { describe, expect, it } from "vitest";
import { podAdminOrigin, podPageRefusal } from "../src/lib/safe-open.js";

describe("podAdminOrigin", () => {
  it.each([
    ["https://sillage.pod.synap.live", "https://admin.sillage.pod.synap.live"],
    ["https://pod.antoinesrvt.synap.live", "https://pod-admin.antoinesrvt.synap.live"],
    ["https://team.synap.live", "https://team-admin.synap.live"],
    ["https://pod.example.com", "https://pod-admin.example.com"],
    ["http://localhost:3000", "http://localhost:4040"],
  ])("%s -> %s", (pod, admin) => {
    expect(podAdminOrigin(pod)).toBe(admin);
  });

  it("allows the console on its own origin, refuses the old wrong host", () => {
    expect(podPageRefusal("https://admin.sillage.pod.synap.live/approve-agent/k", "https://sillage.pod.synap.live")).toBeNull();
    expect(podPageRefusal("https://pod-admin.pod.synap.live/x", "https://sillage.pod.synap.live")).not.toBeNull();
  });
});
