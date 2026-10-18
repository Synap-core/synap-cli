# @synap-core/cli

Connect your AI agents to your Synap pod — sovereign knowledge infrastructure for any agent (Claude Code, Codex, Cursor, and more). Synap is agent-agnostic: you install the agent you like, `synap` connects it.

```bash
npx @synap-core/cli init
```

After `synap init` you have:
- A Synap pod (an existing one, or a new one created in your browser)
- This computer connected to the pod, and each agent found on it wired to Synap's structured memory, entities, documents and governance layer
- Your phone paired with Relay, where agents send their questions

---

## Install

```bash
# Run once (no install needed)
npx @synap-core/cli init

# Or install globally
npm install -g @synap-core/cli
synap init
```

**Requirements**: Node.js 20+

---

## `synap init`

One flow for every machine: find or create a pod, connect this computer (the pod's device flow: a code you approve on any device), connect the agents found here, pair the phone.

For the first key, "Connect this computer" is the recommended option; "Advanced: paste an API key" comes last.

Unattended: `synap init --pod-url <url> --api-key <key> --agents claude-code,codex,cursor --yes`.

---

## Top-level commands

### `synap status`

Health check across the stack: pod, auth, Intelligence Service.

### `synap login`

```bash
synap login                      # Opens browser
synap login --token <token>      # Headless / server
```

Token: [synap.live/account/tokens](https://synap.live/account/tokens). Your session auto-refreshes for 7 days.

### `synap logout`

### `synap connect`

Re-connect an agent to an existing pod without running the full init wizard (`synap connect --target=claude-code`).

### `synap playbook run <name-or-id>`

Start a governed process in one step: `synap playbook run "Design to implementation" --subject <entityId> --param goal="..." [--json]`.
A name resolves through the pod's playbook list (ambiguous or unknown names are refused, candidates listed); `--param` is typed by the playbook's declared params; a required param left out is asked of you by the run, not refused. An agent's run usually comes back as a proposal: that is success, printed with its review link (`synap open proposal <id>`). Same door as MCP `synap_run_playbook`.

---

## Configuration files

Stored in `~/.synap/` (user-only, `chmod 600`):

| File | Contents |
|---|---|
| `credentials.json` | CP auth token |
| `pod-config.json` | Pod URL, workspace ID, agent user ID, Hub API key |

Never commit these.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SYNAP_CP_URL` | `https://api.synap.live` | Control plane URL |
| `SYNAP_LANDING_URL` | `https://synap.live` | Landing page (OAuth callback) |

---

## What the `synap` skill gives your agent

Once connected, your agent gains access to Synap's Hub Protocol:

| Capability | How the agent uses it |
|---|---|
| Store a memory | Save atomic facts, keyword or semantic search |
| Create an entity | Structured object (person, task, note, project, …) |
| Search entities | By name, type, content, relationships |
| Relation graph | Link entities, traverse |
| Documents | Long-form markdown with governance |
| Channels | Post messages to any Synap channel |
| Proposals | Request changes for human review |

Agents self-discover entity types and views at runtime — no hardcoding.

---

## Deployment paths

### Self-hosted (free)

Run the pod on your own machine or server ([backend repo](https://github.com/Synap-core/backend)), then connect to it:

```bash
git clone https://github.com/Synap-core/backend synap && cd synap
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash
synap init --pod-url https://<your-pod-domain>
```

### Managed pod (private beta)

1. Join the waitlist at [synap.live](https://synap.live); once you are in, create your pod there
2. `synap init` and select your pod — the CLI handles the rest

---

## Troubleshooting

**"Could not reach pod"**
Pod unreachable. Check `synap status` and docker compose.

**"Session expired" in synap status**
Run `synap login --token <token>` on the server.

---

## Why Synap

- **Structured memory**: not flat files. PostgreSQL + pgvector + Typesense. Entities, relationships, full-text + semantic search.
- **Governance**: AI mutations go through reviewable proposals.
- **Sovereign**: self-host for free, your data stays yours.

---

## License

MIT
