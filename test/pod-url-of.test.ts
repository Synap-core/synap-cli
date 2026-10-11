import { describe, expect, it } from "vitest";
import { podUrlOf } from "../src/lib/auth.js";

// The CP's GET /pods sends `podUrl` (synap-control-plane-api routes/pods.ts);
// the CLI once read a `url` field that does not exist and fell back to
// `<subdomain>.synap.live`, sending a custom-domain pod to the wrong host.
describe("podUrlOf", () => {
  it("uses the CP's podUrl as sent", () => {
    expect(
      podUrlOf({ podUrl: "https://pod.antoinesrvt.synap.live/", customDomain: "pod.antoinesrvt.synap.live", subdomain: "perso" })
    ).toBe("https://pod.antoinesrvt.synap.live");
  });

  it("derives like the CP when podUrl is absent: the custom domain wins", () => {
    expect(podUrlOf({ customDomain: "pod.antoinesrvt.synap.live", subdomain: "perso" })).toBe(
      "https://pod.antoinesrvt.synap.live"
    );
    expect(podUrlOf({ customDomain: null, subdomain: "team" })).toBe("https://team.synap.live");
  });
});
