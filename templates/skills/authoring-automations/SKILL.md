---
name: authoring-automations
description: Authors a Synap Automation — the WHEN→THEN flow engine (triggers, nodes, data flow). Use whenever the user wants something to happen automatically: "every morning do X", "when a Y is created then Z", "poll this source and create entities", "fan out a list into records", "post to a channel when…", or asks to build/edit an automation flow. Also use when designing the trigger half of a playbook (the WHEN that fires a process).
---

# Authoring Automations

A **Synap Automation** is a WHEN→THEN flow: a **trigger** fires, then a graph of **nodes** runs. It is how recurring work happens without a human in the loop. This skill encodes the VERIFIED capability matrix — the triggers, the nodes, the data-flow grammar, the canonical recipes, and the one firewall gotcha that will bite you.

Read `reference/node-matrix.md` for the exhaustive per-node field reference. Keep flows small: trigger → a couple of steps. Don't over-engineer the first version.

## The template format

Automation templates live at `synap-backend/templates/automations/*.automation.json`:

```jsonc
{
  "name": "URL → Bookmark (inbound messages)",
  "triggerType": "event",
  "status": "active",
  "triggerConfig": { "eventPattern": "external_message.received.*", "filters": { "provider": "discord" } },
  "flowDefinition": {
    "nodes": [ /* each: { id, type, position, data } */ ],
    "edges": [ /* each: { id, source, target } */ ]
  },
  "metadata": { "source": "bridge-template" }
}
```

The canonical `url-bookmark-capture` shape is: **message trigger → transform (`url_extract`) → loop → entity_create (with `dedupeBy`)**. That is the reference for any "extract items from input, create one entity each" flow.

## Triggers (4)

| Trigger | Config | Fires when |
|---|---|---|
| `cron` | `{ expression: "0 9 * * *" }` | The pod-wide scheduler matches (it polls every minute, so minute granularity). |
| `event` | `{ eventPattern: "entities.*" \| "focus_session.stage_changed.*" \| …, filters }` | A matching domain event is emitted. |
| `webhook` | `{ webhookSubscriptionId }` | An inbound webhook hits the subscription. |
| `manual` | — | A user/agent runs it on demand. |

## Nodes (14)

`trigger`, `command`, `condition`, `delay`, `output`, `loop`, `transform`, `fetch`, `query`, `switch`, `skill`, `capability`, `sub_automation`, `playbook_run`. Full fields in `reference/node-matrix.md`. The load-bearing ones:

- **command** — free-form AI step via the Intelligence Service. Powerful but UNTYPED — strongly prefer a `skill` for structured extraction. A `command` feeding a `loop` is a best-effort fallback only (ship `status: "draft"` + a reliability caveat; see below).
- **output** — the side-effect node. Subtypes: `entity_create` (`{ profileSlug, title, dedupeBy, properties }`; governed + empty/dup-guarded; **`dedupeBy` is a SINGLE key**), `entity_update`, `webhook` (POST to an arbitrary URL with vault headers), `notification`, `channel_message`.
- **loop** — iterate an array (cap 100). Its iterator is resolved **RAW** (not stringified) so it works on real arrays.
- **transform** — `uppercase` \| `lowercase` \| `json` \| `trim` \| `url_extract`.
- **fetch** — HTTP (30s timeout, vault headers, auto-JSON-parses the body).
- **skill** — run an IS skill (gated). The right tool for **structured extraction** (returns typed data).
- **capability** — run a capability verb → resolves to a skill (gated).
- **sub_automation** — call another automation (depth limit 5).
- **playbook_run** — start a playbook from a flow.

## Data flow grammar

- `{{trigger.payload.x}}` — fields off the trigger event.
- `{{steps.<nodeId>.output.x}}` — output of a prior node by id.
- `{{loop.item}}` / `{{loop.index}}` — inside a loop body.

**Lossy stringify gotcha:** `resolveTemplate` STRINGIFIES values — fine for strings, **lossy for objects/arrays**. Two paths resolve RAW instead: the **loop iterator** (`iteratorExpression`) and **transform** input. So: build arrays/objects with those raw-path nodes; use `{{…}}` interpolation only where a string is wanted.

**Canonical fan-out:** a `skill` returns `{ items: [...] }` → `loop` over `steps.<skill>.output.items` → `entity_create` per `{{loop.item}}`. This is the backbone of every "source → many entities" automation.

## The canonical "external source → calendar" recipe

```
cron (0 7 * * *)
  → fetch (GET the source URL)
  → skill (structured extraction → returns { events: [...] })
  → loop (iterator: steps.extract.output.events)
  → entity_create (profileSlug: "event", dedupeBy: "externalId", properties from {{loop.item}})
```

**Strongly prefer a skill for structured extraction.** A purpose-built `skill` (like `bookmark-enrichment`) returns typed, reliable structured data you can fan out — that is the path to reach for. A free-form `command` is NOT schema-typed; its IS task output shape is not guaranteed, so a `loop` over it is BEST-EFFORT and may resolve to `[]`. A `command → loop` is an explicit FALLBACK — use it only when no skill or JSON source exists, and when you do, ship the automation `status: "draft"` with a reliability caveat noting the output shape isn't guaranteed. Do not present command-based extraction as reliable.

## THE FIREWALL GOTCHA (critical)

**`channel_message` does NOT relay to Discord.** It only inserts an internal `messages` row. To reach Discord from an automation you must use a **`webhook` node → Discord webhook URL**.

**BUT** that webhook path **bypasses the team-vs-client-comms firewall.** So:

- Posting to an internal **team** channel via webhook: acceptable.
- Posting to anything **client-linked** (a `client-comms` channel, mirrored to the client): **NEVER via an automation webhook.** It must go through the bridge's `proactive_post` / `route_to_channel` path, which enforces the firewall. An automation that webhooks into a client channel leaks bot activity to the client.

When in doubt, route client-facing posts through the bridge, never an automation.

## Authoring checklist

1. Pick the **trigger** (cron / event / webhook / manual) and its config.
2. Sketch the smallest node chain that does the job.
3. For structured extraction → strongly prefer a `skill`. A `command → loop` is a best-effort fallback only — ship it `status: "draft"` with a reliability caveat (output shape not guaranteed; the loop may resolve `[]`).
4. Fan out with `skill → loop → entity_create` + a `dedupeBy` key (idempotency).
5. Reaching Discord? `webhook` node — and if the target is client-linked, route through the bridge instead.
6. Write it as `{ name, triggerType, status, triggerConfig, flowDefinition: { nodes, edges }, metadata }`.
