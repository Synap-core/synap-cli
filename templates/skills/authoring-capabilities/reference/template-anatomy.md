# Capability template anatomy

File: `synap-control-plane-api/src/seeds/capability-templates/<key>.capability.json`. Top-level keys: `key`, `name`, `description`, `params`, `vault`, `tools`, `skills`, `playbooks`, `automations?`.

## params

```jsonc
{ "name": "apiKey", "label": "API key", "type": "text", "required": true,
  "default": "…", "description": "…" }
```
Param values are interpolated into the rest of the template as `{{paramName}}` (and `{{name}}` = the capability name). `type`: `text` | `number` | `entity` | `choice` | `boolean`.

## vault

```jsonc
{ "ref": "apiKeySecret", "name": "{{name}} API key", "value": "{{apiKey}}",
  "type": "api_key", "description": "…" }
```
Each entry is encrypted at apply time and becomes referenceable as `vault://<id>` via its `ref`. **Nango / instruction-only capabilities have an empty `vault[]`.**

## tools

```jsonc
// vault-backed (API key)
{ "name": "generic_api", "kind": "api", "credentialRef": "apiKeySecret",
  "executor": "is-agent",
  "config": { "baseUrl": "{{baseUrl}}",
              "auth": { "in": "header", "name": "Authorization", "prefix": "Bearer " } } }

// Nango (OAuth)
{ "name": "gmail", "kind": "provider", "credentialRef": "nango://google-mail", ... }
```
- `credentialRef`: a vault `ref` (→ `vault://<id>`) OR `nango://<provider>`.
- Tools are created **governed**.
- A tool's **verb catalog is DERIVED** from the skills whose `requires` names that tool — you don't list verbs on the tool.

## skills

```jsonc
{ "name": "draft-outreach", "kind": "instruction", "scope": "pod",
  "description": "…", "requires": ["unipile_linkedin"],
  "code": "# Markdown body injected into the agent's prompt …" }

{ "name": "{{name}} fetch-and-propose", "kind": "code", "scope": "pod",
  "requires": ["generic_api"], "executionMode": "async", "timeoutSeconds": 60,
  "parameters": { "path": "string?" },
  "code": "// JS statement body run in the IS isolate …" }
```
- `kind`: `instruction` (prompt text in `code`) | `code` (JS, born `approved:false`) | `provider` (declarative `providerSpec` HTTP, in-process Tier-1).
- `requires`: the tool names the skill feeds into — this is what derives the tool's verb catalog and wires `member_of` links.
- code skills: `propose.entity({ profileSlug, title, properties })` requires `title` (not `name`) and routes through `checkPermissionOrPropose`. `callProvider(toolName, method, path, body?)` is POSITIONAL; the dispatcher resolves the tool's credential server-side.

## playbooks

The `playbooks[]` array holds full playbook definitions (see the `authoring-playbooks` skill). They are materialized LAST and **REQUIRE a `workspaceId`** at apply time — that is why a capability bundling playbooks is seeded `workspaceScoped: true`.

## automations (optional)

The `automations[]` array can carry WHEN→THEN flows in the same `{ name, triggerType, status, triggerConfig, flowDefinition, metadata }` shape used by `synap-backend/templates/automations/*.automation.json` (see `authoring-automations`).

## Reference templates (in the same directory)

| Template | Shape | Clone it for |
|---|---|---|
| `nango-google.capability.json` | Nango/OAuth, empty vault | Any OAuth connector |
| `cal-com.capability.json` | vault/API-key | A keyed HTTP service |
| `generic-apikey.capability.json` | vault + one api tool + one code skill | The blueprint for a new vault connector |
| `agency-skills.capability.json` | instruction-only skills + 2 playbooks | A know-how + process pack |

Builtin `web_fetch` / `web_search` need no template — they are always available to agents.
