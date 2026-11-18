/**
 * The one name matcher behind every "No capability named …" (finding
 * 1773922e): `cal.com` must find "Cal.com Scheduling", an exact name still
 * runs without a question, and an unrelated word suggests nothing.
 */

import { describe, expect, it } from "vitest";
import { matchByName, normalizeName, scoreName, MIN_SCORE } from "../src/lib/name-match.js";

interface Card {
  name: string;
  key: string;
  description?: string;
}

const CATALOG: Card[] = [
  { name: "Cal.com Scheduling", key: "cal-com-scheduling", description: "Book meetings and read your calendar" },
  { name: "Stripe — Payments & Billing", key: "stripe", description: "Charges, invoices, subscriptions" },
  { name: "Slack — Channels, People & Messages", key: "slack" },
  { name: "Notion — Workspace & Knowledge", key: "notion" },
  { name: "Hetzner Cloud", key: "hetzner-cloud" },
];

const fields = (c: Card) => ({ names: [c.name, c.key], words: [c.description ?? ""] });
const names = (m: ReturnType<typeof matchByName<Card>>) =>
  m.kind === "near" ? m.candidates.map((c) => c.name) : m.kind === "exact" ? [m.item.name] : [];

describe("normalizeName", () => {
  it("keeps only letters and digits, lower case, no accents", () => {
    expect(normalizeName("Cal.com")).toBe("calcom");
    expect(normalizeName("  Équipe — Café ")).toBe("equipecafe");
  });
});

describe("matchByName", () => {
  it("runs an exact name or key without asking (case-insensitive)", () => {
    expect(matchByName(CATALOG, "hetzner cloud", fields)).toMatchObject({ kind: "exact" });
    expect(matchByName(CATALOG, "STRIPE", fields)).toMatchObject({ kind: "exact" });
  });

  it("treats a name that is the same once punctuation is dropped as exact, when only one is", () => {
    const m = matchByName(CATALOG, "cal com scheduling", fields);
    expect(m.kind).toBe("exact");
    expect(names(m)).toEqual(["Cal.com Scheduling"]);
  });

  it("suggests Cal.com Scheduling for `cal.com` (the founder's dogfood), first", () => {
    const m = matchByName(CATALOG, "cal.com", fields);
    expect(m.kind).toBe("near");
    expect(names(m)[0]).toBe("Cal.com Scheduling");
  });

  it("suggests through a typo", () => {
    expect(names(matchByName(CATALOG, "strpie", fields))[0]).toBe("Stripe — Payments & Billing");
    expect(names(matchByName(CATALOG, "hetzner clod", fields))[0]).toBe("Hetzner Cloud");
  });

  it("suggests through a word of the description", () => {
    expect(names(matchByName(CATALOG, "calendar", fields))).toEqual(["Cal.com Scheduling"]);
  });

  it("suggests nothing for an unrelated word", () => {
    expect(matchByName(CATALOG, "kubernetes", fields)).toEqual({ kind: "none" });
    expect(matchByName(CATALOG, "   ", fields)).toEqual({ kind: "none" });
  });

  it("caps the suggestions", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Mail ${i}`, key: `mail-${i}` }));
    const m = matchByName(many, "mail", fields, 5);
    expect(m.kind === "near" && m.candidates.length).toBe(5);
  });
});

describe("scoreName", () => {
  it("scores an unrelated name below the suggestion floor", () => {
    expect(scoreName("cal.com", "Hetzner Cloud")).toBeLessThan(MIN_SCORE);
  });
});
