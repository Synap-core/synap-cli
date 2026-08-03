import { describe, expect, it, vi } from "vitest";
import {
  automate,
  buildAutomatePrompt,
  type AutomateOpts,
} from "../src/commands/automate.js";

describe("buildAutomatePrompt", () => {
  it("preserves the request and requires capability discovery plus governance", () => {
    const prompt = buildAutomatePrompt("Every Friday, summarize new customer feedback.");

    expect(prompt).toContain("Every Friday, summarize new customer feedback.");
    expect(prompt).toMatch(/inspect the existing capabilities, installed templates/i);
    expect(prompt).toMatch(/missing capability or connection prerequisite/i);
    expect(prompt).toMatch(/Never install a capability.*create a connection/i);
    expect(prompt).toMatch(/React.*stored in Synap.*Ingest \/ store/s);
    expect(prompt).toMatch(/Never invent an external trigger/i);
    expect(prompt).toContain('"Gets data"');
    expect(prompt).toContain('"Stores in Synap"');
    expect(prompt).toContain('"Reacts & sends"');
    expect(prompt).toMatch(/must match the dataContract supplied to create_automation/i);
    expect(prompt).toMatch(/governed automation proposal/i);
    expect(prompt).toMatch(/Do not directly create, activate, or enable/i);
  });

  it("trims incidental whitespace around the user's instruction", () => {
    expect(buildAutomatePrompt("  remind me tomorrow  ")).toContain(
      "User request:\nremind me tomorrow"
    );
  });
});

describe("automate", () => {
  it("forwards supported agent options and the canonical prompt through agentAsk", async () => {
    const ask = vi.fn().mockResolvedValue(undefined);
    const opts: AutomateOpts = {
      workspace: "Operations",
      thread: "thread-123",
      new: true,
      timeout: "45",
      json: true,
      podUrl: "https://pod.example",
      apiKey: "test-key",
    };

    await automate("Alert me about high-priority support tickets.", opts, ask);

    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({
      ...opts,
      message: buildAutomatePrompt("Alert me about high-priority support tickets."),
    });
  });

  it("rejects a whitespace-only instruction before it reaches the agent", async () => {
    const ask = vi.fn().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await automate("  ", {}, ask);

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("an instruction is required")
    );
    expect(ask).not.toHaveBeenCalled();

    exit.mockRestore();
    error.mockRestore();
  });
});
