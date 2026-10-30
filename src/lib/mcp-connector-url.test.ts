import { describe, it, expect } from "vitest";
import { MANAGED_MCP_URL, mcpConnectorUrl } from "./auth.js";

describe("mcpConnectorUrl", () => {
  it("gives the managed control plane's public connector host", () => {
    expect(MANAGED_MCP_URL).toBe("https://mcp.synap.live");
    expect(mcpConnectorUrl("https://api.synap.live")).toBe(MANAGED_MCP_URL);
    expect(mcpConnectorUrl("https://api.synap.live/")).toBe(MANAGED_MCP_URL);
  });

  it("keeps <cp>/mcp for a self-hosted control plane", () => {
    expect(mcpConnectorUrl("https://api.acme.example")).toBe("https://api.acme.example/mcp");
  });
});
