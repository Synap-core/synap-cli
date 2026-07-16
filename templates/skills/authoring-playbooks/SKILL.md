---
name: authoring-playbooks
description: Authors a Synap Playbook — the session-template process object that turns a goal into ordered stages over a subject entity. Use whenever the user asks to create a playbook, build a process, design a workflow with stages, set up a "process for X", add or reorder stages, or define what an agent session should do step by step (e.g. "build me a client-onboarding process", "make a 3-stage research playbook", "add a review stage").
---

# Authoring Playbooks

A **Playbook** is the process object in Synap: a reusable template for an AI working session. It declares a goal, the parameters that specialize it, the capabilities it is allowed to use, where it runs, what it should produce, and — first-class now — the **ordered stages** a subject moves through. When a playbook runs it instantiates a `focus_session` over a single **subject** entity, advancing one stage at a time.

This skill teaches the data model, the live authoring path, the field reference, and the run lifecycle. Read `reference/stages-contract.md` before writing stages, and `reference/worked-example.md` for a full example.

## The mental model (memorize this)

```
automation (WHEN, the trigger)
   └─> playbook_run            (a process template, instantiated)
          └─> over a SUBJECT entity   (subjectProfile resolves which one)
                 └─> in a focus_session (the runtime instance)
                        └─> currentStage = the one active stage key
```

- A playbook is a **template**. A `focus_session` is a **running instance** of it.
- A subject is in **exactly ONE stage at a time** — `focus_sessions.currentStage` holds the active stage key.
- An **automation** decides WHEN a playbook runs (its `flowAutomationId` wires the trigger). The playbook decides WHAT happens once running.
- The session works **over a subject**: one `company`, one `deal`, one `person`, etc. — resolved through `subjectProfile`.

## The LIVE authoring path (where playbooks actually ship)

A playbook is **not** authored as a standalone file. It ships **inside a CapabilityDefinition's `playbooks[]` array**:

1. Define it in the capability template: `synap-control-plane-api/src/seeds/capability-templates/<key>.capability.json`, under `"playbooks": [ ... ]`.
2. It is materialized by `createCapabilityFromDefinition()` when the capability is applied via `POST /api/hub/capabilities/apply`. Playbooks REQUIRE a `workspaceId` at apply time.
3. The Discord bridge seeds it by adding the capability key to `AGENCY_CAPABILITY_PLAN` in `synap-cli/src/commands/bridge-setup.ts` with `workspaceScoped: true` (the flag that tells the bridge this capability bundles playbooks, so it must be applied with a workspace).

**GOTCHA — do not copy the vestigial file.** `synap-control-plane-api/templates/packs/deep-research.playbook.json` looks like a standalone playbook template but it is VESTIGIAL: its playbook-specific fields are dropped during materialization. Never copy it or treat it as the schema. The authoritative shape is the `playbooks[]` entry inside a `.capability.json`. For a real example **with ordered stages**, see `stellar-grant-client.capability.json` and `reference/worked-example.md` (note: `agency-skills.capability.json` bundles playbooks but their `stages` are `[]`, so it does not demo the stages contract).

## Playbook field reference

| Field | Type / shape | Meaning |
|---|---|---|
| `name` | string | Display name. |
| `description` | string | What this process does and when it runs. |
| `goalTemplate` | string with `@{arg:…}` grammar | The session's objective. Interpolate params with `@{arg:paramName}`. |
| `params` | `{ name, label?, type, required?, description? }[]` | Inputs that specialize a run. `type`: `text` \| `number` \| `entity` \| `choice` \| `boolean`. |
| `inputStrategy` | `{ kind, description? }` | What the session iterates over. `kind`: `none` \| `static` \| `rotating` \| `query`. |
| `channelSpec` | `{ type, aiReactionMode? }` | Where it runs. `type`: `GROUP` \| `AGENT_COLLAB` \| `THREAD`. |
| `expectedOutputs` | `{ kind, label }[]` | The deliverables a run should produce (drives the output checklist). `kind` is **loosely typed** — stick to the shared vocab `note` \| `document` \| `report` for consistency, though any string is accepted. |
| `schedule` | `{ cron, enabled }` \| `null` | Optional recurring schedule. |
| `executor` | enum | `is-agent` \| `external-agent` \| `hybrid` — who runs the session. |
| `subjectProfile` | `{ profileSlug, filter? }` | The profile of the subject entity the session operates over. |
| `flowAutomationId` | id | The automation whose trigger fires this playbook (the WHEN). **Set post-create by a separate mutation — NOT settable via the template.** |
| `stages` | `PlaybookStage[]` (ordered) | The ordered process steps. See `reference/stages-contract.md`. |
| `grants` | `CapabilityRef[]` (stage-level only) | Advisory capability hints surfaced to the agent. See below. |

### grants — advisory capability hints (NOT enforcement)

A `grant` is a `CapabilityRef`: `{ kind, id }` where `kind` is `tool` \| `skill` \| `command` and `id` names the capability. Two things to know before you rely on them:

- **Top-level playbook `grants` are DROPPED.** They are not part of `PlaybookDefSchema` / playbook create, so a `grants` array at the playbook level is silently ignored during materialization. Declare grants on **stages** instead.
- **Stage `grants` are stored as opaque JSON and are currently ADVISORY.** They are surfaced to the agent at runtime via `RunContext` (the is-agent executor lists a stage's grants in the kickoff prompt) but are **NOT resolved into enforcement `capability` / `link` rows** — nothing blocks the agent from using an ungranted capability, and nothing auto-wires a granted one. Hard enforcement is a documented FOLLOW-UP, not current behavior.

Because of this, "granting" a skill at a stage really means **telling the agent to use that skill at that stage**. An `instruction` skill (e.g. `stellar-scf-grants-advisor`) is already available to the agent through the pod skill catalog + `load_skill` REGARDLESS of any grant — listing it in a stage's `grants` just points the agent at it as the stage's working methodology. Builtin `web_fetch` / `web_search` are always available and need no grant.

## The STAGES contract (the new first-class field)

Stages are **ordered** and drive the session's progression. Read `reference/stages-contract.md` for the full schema and event semantics. In brief:

```jsonc
"stages": [
  {
    "key": "scope",                       // stable id, referenced by currentStage
    "name": "Scope",
    "description": "Understand the client and their problem.",
    "goal": "Produce a one-paragraph problem statement.",   // optional
    "grants": [{ "kind": "skill", "id": "client-brief" }],  // optional, advisory hint (not enforced)
    "expectedOutputs": [{ "kind": "note", "label": "Problem statement" }],
    "suggestedTasks": ["Read the intake form", "List open questions"]
  }
]
```

- The running session tracks `focus_sessions.currentStage` (the active stage key).
- Changing `currentStage` emits a **`focus_session.stage_changed`** event — automations can trigger on it (e.g. notify when a subject reaches "build").
- **Empty `stages`** = legacy progress-only behavior (a single 0→100% bar, no stage events).

## Run lifecycle

1. **Start** — `playbooks.run` (tRPC) or `synap_start_session`. Instantiates a `focus_session` over the resolved subject, `currentStage` = first stage key.
2. **Advance** — `synap_update_session`: set `currentStage` to move stages (emits `stage_changed`), update `progress`, `addOutput` / `completeOutput` as deliverables land.
3. **Complete** — `synap_complete_session` when the goal is met.

## Authoring checklist

1. State the **goal** as a `goalTemplate` with `@{arg:…}` for anything parameterized.
2. Define **params** (minimum needed to specialize a run).
3. Pick the **subjectProfile** — what single entity is each run about?
4. Write **ordered stages** — each with a clear `goal` and `expectedOutputs`. One subject, one active stage.
5. Declare stage **grants** to point the agent at the skills/tools each stage should use (advisory hints, not an access gate; put them on stages, not the playbook level).
6. Set **channelSpec**, **executor**, and (optionally) **schedule**.
7. Place it in the capability template's `playbooks[]` and add the key to `AGENCY_CAPABILITY_PLAN` (`workspaceScoped: true`).

See `reference/worked-example.md` for a complete 3-stage client-process playbook over a `company` subject.
