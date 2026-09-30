/**
 * `synap session wait` prints the TYPED half of an answer (W2 typed asks):
 * a structured pick (confirm / chip / form / provide) gets its own line; a
 * plain `{type:"text"}`, a pod that predates typed answers (no `value`), and a
 * malformed value print nothing extra.
 */
import { describe, it, expect } from "vitest";
import { typedValue, type SessionAnswer } from "../src/commands/session-wait.js";

const base: SessionAnswer = {
  id: "m1",
  text: "Ship Friday",
  answeredAt: "2026-09-27T00:00:00.000Z",
  answeredBy: "owner",
  messageId: "m1",
  slot: null,
  question: null,
};

describe("typedValue", () => {
  it("returns a structured pick", () => {
    const value = { type: "chip", chip: { label: "Ship Friday", value: "fri" } };
    expect(typedValue({ ...base, value })).toEqual(value);
    expect(typedValue({ ...base, value: { type: "confirm", confirmed: true } })).toEqual({
      type: "confirm",
      confirmed: true,
    });
  });

  it("skips free text, a missing value, null and a malformed value", () => {
    expect(typedValue({ ...base, value: { type: "text" } })).toBeNull();
    expect(typedValue(base)).toBeNull();
    expect(typedValue({ ...base, value: null })).toBeNull();
    expect(
      typedValue({ ...base, value: { kind: "chip" } as unknown as SessionAnswer["value"] })
    ).toBeNull();
  });
});
