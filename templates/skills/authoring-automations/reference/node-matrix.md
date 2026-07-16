# Automation node matrix (exhaustive)

Every node is `{ id, type, position: {x,y}, data }`. Edges are `{ id, source, target }`. `data` shape varies by `type`.

## Triggers (4)

| triggerType | triggerConfig | Notes |
|---|---|---|
| `cron` | `{ expression: "0 9 * * *" }` | Pod-wide scheduler polls every minute → minute granularity, no sub-minute. |
| `event` | `{ eventPattern, filters }` | Patterns: `entities.*`, `focus_session.stage_changed.*`, `external_message.received.*`, etc. `filters` narrows by payload fields (e.g. `{ provider: "discord" }`). |
| `webhook` | `{ webhookSubscriptionId }` | Fires on inbound webhook delivery. |
| `manual` | — | On-demand run by user/agent. |

## Nodes (14)

| type | Purpose | Key fields / config |
|---|---|---|
| `trigger` | Entry node mirroring the trigger | `{ triggerType, config }` |
| `command` | Free-form AI step via IS | prompt; UNTYPED output — strongly prefer a `skill` for extraction. `command → loop` is a best-effort fallback only (ship `status: "draft"` + reliability caveat; output shape not guaranteed, loop may resolve `[]`) |
| `condition` | Branch on a safe comparison | safe comparators (eq, neq, gt, lt, contains…); no arbitrary eval |
| `delay` | Pause the flow | `5m` \| `1h` \| `1d` \| `1w` |
| `output` | Side effects (see subtypes below) | `outputType` + `config` |
| `loop` | Iterate an array | `iteratorExpression` (RAW path); cap **100**. `itemVariable` is currently IGNORED by the executor (it only binds `context.loop.item`) — reference items as `{{loop.item.*}}`, not the named var |
| `transform` | String transform | `expression: "<raw path> \| op"`; ops: `uppercase`, `lowercase`, `json`, `trim`, `url_extract` |
| `fetch` | HTTP request | URL, method, vault headers; 30s timeout; auto-JSON-parses body |
| `query` | Read entities from the pod | profile + filter |
| `switch` | Multi-way branch | cases on a value |
| `skill` | Run an IS skill (gated) | skill name + args; returns STRUCTURED data — use for extraction |
| `capability` | Run a capability verb → skill (gated) | verb resolves to a skill |
| `sub_automation` | Call another automation | depth limit **5** |
| `playbook_run` | Start a playbook | playbook ref + params/subject |

## `output` subtypes

| outputType | config | Notes |
|---|---|---|
| `entity_create` | `{ profileSlug, title, dedupeBy, properties }` | Governed (proposal-gated). Empty/duplicate guarded. **`dedupeBy` is a SINGLE key**, not a list. |
| `entity_update` | target + properties | Governed. |
| `webhook` | `{ url, method, headers, body }` | POST to ANY URL; headers can pull from the vault. The ONLY way to reach Discord from an automation. |
| `notification` | message/target | In-app notification. |
| `channel_message` | channel + content | Inserts an internal `messages` row ONLY. Does NOT relay to Discord/Telegram. |

## Data-flow paths

- `{{trigger.payload.x}}` — trigger event fields.
- `{{steps.<nodeId>.output.x}}` — a prior node's output.
- `{{loop.item}}`, `{{loop.index}}` — inside a loop body.

**Resolution rule:** `{{…}}` interpolation goes through `resolveTemplate`, which STRINGIFIES (lossy for objects/arrays). The **loop `iteratorExpression`** and **transform `expression`** input resolve the path RAW — that is why looping over `steps.extract.output.events` works on the real array. Build/iterate structured data with those raw-path fields; reserve `{{…}}` for string slots.
