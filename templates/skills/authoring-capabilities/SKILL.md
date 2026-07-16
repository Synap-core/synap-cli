---
name: authoring-capabilities
description: Authors a Synap Capability template — the delivery vehicle that bundles tools + skills + playbooks + automations into one applyable .capability.json. Use whenever the user wants to connect a service (OAuth or API key), package a reusable know-how/process pack, ship a new connector, or assemble several skills and a process into one installable bundle. This is the top of the authoring stack: pick the pack shape, then author the playbook (process) and automations (when) inside it.
---

# Authoring Capabilities

A **Capability** is the delivery vehicle in Synap: a named container that bundles **tools** (connections), **skills** (know-how/code), **playbooks** (processes), and optionally **automations** (when), applied as one unit. This skill teaches the template file, the skill kinds, the connector shapes, and how to seed it. It is the top of the three-skill authoring stack — compose it with `authoring-playbooks` and `authoring-automations`.

Read `reference/template-anatomy.md` for the full field reference and reference templates.

## The file

`synap-control-plane-api/src/seeds/capability-templates/<key>.capability.json`:

```jsonc
{
  "key": "my-connector",
  "name": "My Connector",
  "description": "What this bundle gives an agent and when to use it.",
  "params": [ /* { name, label, type, required?, default?, description } */ ],
  "vault": [ /* secrets to encrypt */ ],
  "tools": [ /* connectors */ ],
  "skills": [ /* know-how + code */ ],
  "playbooks": [ /* processes — REQUIRE a workspaceId at apply time */ ],
  "automations": [ /* optional WHEN→THEN flows */ ]
}
```

## Materialization order (idempotent)

`createCapabilityFromDefinition()` applies parts in dependency order:

1. **vault** — encrypt each secret → it becomes referenceable as `vault://<id>` by its `ref`.
2. **tools** — created governed. A tool's `credentialRef` resolves: a `ref` name → `vault://<id>`, or `nango://<provider>` for OAuth. A tool's **verb catalog is DERIVED** from the skills that `requires` it.
3. **skills** — created (instruction skills injected as prompt; code skills born `approved: false`).
4. **playbooks** — created LAST among content; they **REQUIRE a `workspaceId`** (a playbook is workspace-scoped).
5. **container** — the capability itself, with `member_of` links wiring all parts together.

Re-applying is idempotent — existing parts are matched, not duplicated.

## Skill kinds — pick the right one

| `kind` | What it is | When to use |
|---|---|---|
| `instruction` | Markdown injected into the agent's prompt (the `code`/body field holds the text) | Pure know-how: methodology, rules, how to draft/classify. No execution, no connector calls. |
| `code` | JS run in the IS isolate (sandboxed). Born `approved: false`. | Executable logic: fetch + transform + propose entities. Needs review before it runs. |
| `provider` | Declarative `providerSpec` (HTTP), run **in-process Tier-1** — NOT via the IS. | A trusted, declarative HTTP verb (e.g. a provider call) that doesn't need the AI isolate. Lowest latency. |

**`provider`-kind skills work only via the SEED-FILE path.** The inline Hub `POST /api/hub/capabilities/apply { definition }` route validates skills with a `SkillDefSchema` that accepts only `instruction` | `code` — so a `provider` skill passed inline is rejected. To ship a `provider` skill, seed it from a `<key>.capability.json` template (the seed path), not via an inline `definition`.

## Connector shapes — Nango (OAuth) vs vault-generic (API key)

| | Nango / OAuth | Vault-generic / API key |
|---|---|---|
| tool `kind` | `provider` | `api` |
| `credentialRef` | `nango://<provider>` | a `ref` → `vault://<id>` |
| `vault[]` | empty (Nango holds the token) | one entry (the API key) |
| tool `config` | provider-defined | `{ baseUrl, auth: { in, name, prefix } }` |
| Reference template | `nango-google.capability.json` | `generic-apikey.capability.json` |

**Reference templates (the molds to clone):**
- `nango-google` — Nango/OAuth connector.
- `cal-com` — vault/API-key connector.
- `agency-skills` — instruction-only pack + 2 playbooks. **The mold for a know-how + process pack.**
- `generic-apikey` — the blueprint to clone for any new vault-backed connector.

**Builtin `web_fetch` / `web_search` are always available** — no template needed just to read a URL.

## Seeding the capability

Two ways:

- **Via the bridge:** add the key to `AGENCY_CAPABILITY_PLAN` in `synap-cli/src/commands/bridge-setup.ts`. Set `workspaceScoped: true` if it bundles playbooks (so the bridge applies it WITH a workspace).
- **Directly:** `POST /api/hub/capabilities/apply` with `{ templateKey | definition, params, workspaceId }`.

## How the three authoring skills compose

A subagent given a plain goal ("build a process for X") works top-down:

1. **authoring-capabilities** (this skill) → pick the pack shape and the connectors it needs (Nango? API key? instruction-only?).
2. **authoring-playbooks** → design the process: ordered stages, subject, grants.
3. **authoring-automations** → design the WHEN: the trigger(s) that fire the playbook and any fan-out flows.
4. **Emit** the `.capability.json` (with `skills[]` + `playbooks[]`) plus any `*.automation.json`, then seed via the plan or `apply`.

## Authoring checklist

1. Choose the shape: connector (Nango/API key) or pure know-how/process pack.
2. Declare `params` and `vault` (empty for Nango / instruction-only).
3. Add `tools` with the right `credentialRef`; let verbs derive from skills' `requires`.
4. Add `skills` — pick `instruction` / `code` / `provider` per skill.
5. Add `playbooks` (remember: needs a workspaceId) and optional `automations`.
6. Seed via `AGENCY_CAPABILITY_PLAN` (`workspaceScoped` matching whether it has playbooks) or `POST /api/hub/capabilities/apply`.
