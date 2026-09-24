# @synap-core/cli

Connect AI agents (Claude Code, Claude Desktop, Cursor, ChatGPT, Grok, Codex, Raycast, and more) to your Synap pod — sovereign, structured knowledge infrastructure for AI agents, over MCP.

```bash
npx @synap-core/cli init
```

`synap init` detects your environment (existing [OpenClaw](https://github.com/openclaw/openclaw) instance, fresh server, or managed pod), connects or provisions a Synap pod, and installs the `synap` skill. After it finishes, you get:
- A connected Synap pod (self-hosted or managed), saved to `~/.synap/`
- The `synap` skill installed for the agent surface(s) it detected
- A dedicated agent API key (never your human key) wired into each surface's MCP config
- `synap connect` / `synap mcp` ready to wire up further clients (Claude Desktop, Cursor, Grok, Codex, Raycast, ChatGPT, claude.ai, …)

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

Detailed environment setup: [docs/INSTALL.md](docs/INSTALL.md)

---

## Core commands

`synap init` is the one-shot setup command — run it first. Everything else connects
additional surfaces, checks on things, or works the pod day to day. This list is a
starting point; run `synap --help` or `synap <command> --help` for the full, current
command tree (the CLI is the source of truth).

### Setup & connection

| Command | What it does |
|---|---|
| `synap init` | Full setup: connect to a Synap pod and install the skill |
| `synap launch` | Stand up a NEW company/OS on a pod — creates a project + its core workspaces |
| `synap connect [client]` | Connect an AI surface (Claude Code, Cursor, Grok, Raycast, …) to a Synap pod |
| `synap mcp url` | Print a ready-to-paste MCP connection (URL + key) for header-based clients like Raycast |
| `synap mcp connect-claude` | Print the OAuth connection steps for the Synap Cloud MCP (claude.ai, ChatGPT custom connectors) |
| `synap login` | Connect your Synap account (private templates) + check on your pods |
| `synap pods` | Manage multiple pod profiles (`add`, `use`, `update`, `remove`, `reconnect`) |
| `synap switch [name]` | Switch the active pod (interactive picker) |

### Status & diagnostics

| Command | What it does |
|---|---|
| `synap status` | Show Synap pod health and API status |
| `synap doctor` | Coherence preflight — pod host resolves, key authenticates, workspace/project exist |
| `synap versions` | Show local vs npm vs control-plane vs pod version drift |
| `synap whoami` | Show key owner vs effective user, scopes/workspace |
| `synap connections` | Show which pod each agent surface (Claude Code, Desktop, Cursor, Raycast) is connected to |
| `synap update` | Update the synap skill and check for CLI updates |

### Working the pod

`synap orient`, `synap ask <query>`, `synap capture [text]`, `synap workspace`,
`synap project`, `synap entities`, `synap session`, `synap agent`, `synap automation`,
`synap market`, and more — these are how you (or an agent) actually use a connected
pod day to day.

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

The skill is published on [ClawHub](https://clawhub.ai) as `synap`. Once installed, your agent gains access to Synap's Hub Protocol:

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

```bash
git clone https://github.com/synap-core/synap-backend
cd synap-backend/deploy
docker compose --profile openclaw up -d
synap init  # → "Connect to existing pod" → http://localhost:4000
```

### Managed pod ($15–20/mo)

1. Create a pod at [synap.live](https://synap.live)
2. `synap init` → "Connect to Synap cloud pod"
3. Select your pod — the CLI provisions the agent key, installs the skill, and wires up MCP

---

## Troubleshooting

**"Could not reach pod"**
Pod unreachable. Check `synap status` and docker compose.

**"OpenClaw is not running yet"**
First boot takes 1–2 minutes on a fresh server. Wait, then re-run `synap init`.

**MCP client doesn't show tools**
Run `synap mcp url --client <name>` (or `synap connect <client>`) to get a ready-to-paste config with a fresh agent key. Restart your AI client.

**"Session expired" in synap status**
Run `synap login --reconnect <pod-name>` (or `synap pods reconnect`) to refresh credentials.

---

## Why Synap

- **Structured memory**: not flat files. PostgreSQL + pgvector + Typesense. Entities, relationships, full-text + semantic search.
- **Governance**: AI mutations go through reviewable proposals.
- **Sovereign**: self-host for free, your data stays yours.

---

## License

MIT
