/**
 * `synap app connect` run with an AGENT's credential: the pod refuses to
 * register or connect an app ("An agent credential cannot register an app —
 * sign in as the app's owner") and that stays so. What changes (2 Nov 2026):
 * instead of only failing, the CLI prints the exact `synap keys request
 * --permission …` command built from `synap.app.json`'s requests, so the
 * agent asks its person for a key with exactly that reach.
 *
 * Pure seams: recognising the refusal, and building the commands.
 */

import { describe, expect, it } from "vitest";
import { HubApiError } from "@synap-core/hub-rest-client";
import {
  isAgentCredentialRefusal,
  keysRequestCommandsFor,
  type AppManifest,
} from "../src/commands/app.js";

const MANIFEST: AppManifest = {
  version: 1,
  name: "sillage",
  logoUrl: null,
  mode: "specific",
  pod: "https://pod.example",
  requests: [
    { permission: "entity.company.update", workspace: "Sillage" },
    { permission: "entity.company.read", workspace: "sillage " },
    { permission: "facet.create", workspace: "Sillage" },
    { permission: "facet.create", workspace: "Sillage" },
  ],
  deploy: { target: "env", env: { key: "SILLAGE_API_KEY", podUrl: "SILLAGE_POD_URL" } },
};
const WS = "05b3b548-bc39-4b09-bf64-e4e3d46d5d8f";

describe("isAgentCredentialRefusal", () => {
  it("is the pod's 403 for an agent credential, and nothing else", () => {
    const msg = "An agent credential cannot register an app — sign in as the app's owner.";
    expect(isAgentCredentialRefusal(new HubApiError(msg, 403, { error: msg }))).toBe(true);
    expect(isAgentCredentialRefusal(new HubApiError("Forbidden", 403, { error: msg }))).toBe(true);
    expect(isAgentCredentialRefusal(new HubApiError("Forbidden", 403, { error: "Missing scope" }))).toBe(false);
    expect(isAgentCredentialRefusal(new HubApiError(msg, 500))).toBe(false);
    expect(isAgentCredentialRefusal(new Error(msg))).toBe(false);
  });
});

describe("keysRequestCommandsFor", () => {
  it("one command per space, each permission once, the manifest's name and key variable", () => {
    const { commands, notes } = keysRequestCommandsFor(MANIFEST, new Map([["sillage", WS]]));
    expect(commands).toEqual([
      "synap keys request --permission entity.company.update --permission entity.company.read " +
        `--permission facet.create --workspace ${WS} --name sillage --out synap-key.env --env-name SILLAGE_API_KEY`,
    ]);
    expect(notes).toEqual([]);
  });

  it("a space it cannot resolve gets a placeholder and a note, never a guess", () => {
    const { commands, notes } = keysRequestCommandsFor(MANIFEST, new Map());
    expect(commands[0]).toContain(`--workspace '<id of Sillage>'`);
    expect(notes.join(" ")).toContain("Sillage");
  });

  it("two spaces are two keys, named and filed apart; quoting where a shell needs it", () => {
    const m: AppManifest = {
      ...MANIFEST,
      name: "My app",
      requests: [
        { permission: "document.read", workspace: "Ops" },
        { permission: "entity.task.create", workspace: "Brand Team" },
      ],
      deploy: { target: "vercel", env: {} },
    };
    const { commands } = keysRequestCommandsFor(
      m,
      new Map([
        ["ops", "11111111-1111-4111-8111-111111111111"],
        ["brand team", "22222222-2222-4222-8222-222222222222"],
      ])
    );
    expect(commands).toEqual([
      "synap keys request --permission document.read --workspace 11111111-1111-4111-8111-111111111111 " +
        "--name 'My app (Ops)' --out synap-key-ops.env --env-name SYNAP_HUB_API_KEY",
      "synap keys request --permission entity.task.create --workspace 22222222-2222-4222-8222-222222222222 " +
        "--name 'My app (Brand Team)' --out synap-key-brand-team.env --env-name SYNAP_HUB_API_KEY",
    ]);
  });

  // A list may not hold `*` (the pod refuses it): full access is its template.
  it("a * request becomes the full-access template, with a note", () => {
    const m: AppManifest = { ...MANIFEST, requests: [{ permission: "*", workspace: "Sillage" }] };
    const { commands, notes } = keysRequestCommandsFor(m, new Map([["sillage", WS]]));
    expect(commands).toEqual([
      `synap keys request full-access --workspace ${WS} --name sillage --out synap-key.env --env-name SILLAGE_API_KEY`,
    ]);
    expect(notes.join(" ")).toMatch(/full access/i);
  });
});
