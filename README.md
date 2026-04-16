# @synap-core/cli

Connect [OpenClaw](https://github.com/openclaw/openclaw) to your Synap pod — sovereign knowledge infrastructure for AI agents.

```bash
npx @synap-core/cli init
```

After `synap init` + `synap finish`, you get:
- A running Synap pod with the `synap` skill installed in OpenClaw
- OpenClaw connected to Synap's structured memory, entities, documents, and governance layer
- An AI provider key configured inside OpenClaw
- A public HTTPS dashboard URL (managed pods) — no SSH tunnel needed
- MCP client configs (Claude Desktop / Cursor / Windsurf) ready to paste

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

## The two-command flow

`synap init` + `synap finish` is the full path. `init` handles detection and provisioning; `finish` wires everything up.

### `synap init`

Detects your environment and picks one of three paths:

| Path | When |
|---|---|
| **A** — Existing OpenClaw | OpenClaw is already running locally |
| **B** — Fresh server | No OpenClaw — starts pod + OpenClaw via Docker |
| **C** — Desktop / managed pod | Connects to a Synap-hosted pod |

On a fresh server, OpenClaw's first boot takes a few minutes (image pull + init). Run `synap finish` once it's up.

### `synap finish`

One-shot completion. Runs:
1. **Skill install** — `openclaw skills install synap` (from ClawHub)
2. **Workspace seed** — creates Agent OS entities
3. **AI provider setup** — prompts you for a key if OpenClaw doesn't have one, writes it via `openclaw config set env.ANTHROPIC_API_KEY …`
4. **Public dashboard** (managed pods) — offers to expose `openclaw.yourpod.synap.live` via the CP, with Synap-session-based auth (no extra password)
5. **Intelligence Service** — optional, routes AI through your pod

After this, everything is ready. No follow-up commands.

Flags:
```bash
synap finish --skip-ai-key    # Don't prompt for AI key
synap finish --skip-domain    # Don't offer public domain
synap finish --skip-is        # Don't configure IS
```

---

## `synap openclaw` — everything OpenClaw

Wraps the things you actually need after install.

### `synap openclaw`

Overview: gateway status, AI provider, skill, dashboard URL, next steps.

### `synap openclaw connections`

Single-screen summary of what's wired up: AI providers (Anthropic/OpenAI/Google/Synap IS), installed skills, connected channels (Telegram/Discord/WhatsApp/Slack/Signal/iMessage/Matrix), MCP client commands, and the dashboard URL.

```bash
synap openclaw connections
```

Everything marked `○` is something you'd manage from the OpenClaw dashboard — the command shows you exactly how to get there.

### `synap openclaw open [section]`

Deep-link to a specific dashboard section.

```bash
synap openclaw open                # Main dashboard
synap openclaw open channels       # Channels tab
synap openclaw open skills         # Skills tab
synap openclaw open config         # Config editor
synap openclaw open chat           # Chat
synap openclaw open sessions       # Sessions
synap openclaw open logs           # Logs
```

Uses the public URL if `setup-domain` has been run, otherwise localhost.

### `synap openclaw dashboard`

Opens the OpenClaw web UI. If a public domain is configured, opens it directly. Otherwise opens `http://localhost:18789` or — on a remote Linux server — prints an SSH tunnel command.

### `synap openclaw connect`

Generates MCP client configs for Claude Desktop, Cursor, Windsurf — **with the gateway token pre-filled** so remote setups work without manual editing.

```bash
synap openclaw connect                  # All three clients
synap openclaw connect --client claude  # Just Claude Desktop
```

### `synap openclaw configure`

Sets OpenClaw's AI provider via its own config system (`openclaw config set env.ANTHROPIC_API_KEY …`). No `.env` hacking — the real OpenClaw config layer.

```bash
# Interactive (in CLI)
synap openclaw configure

# Interactive (hand off to OpenClaw's own wizard)
synap openclaw configure --interactive

# Scripted
synap openclaw configure --provider anthropic --key sk-ant-... --model anthropic/claude-sonnet-4-6

# Read current config
synap openclaw configure --show
```

### `synap openclaw token`

Reads the OpenClaw gateway token from the container. You need this to connect MCP clients to a remote gateway.

```bash
synap openclaw token                  # Print it
synap openclaw token --copy           # Copy to clipboard
synap openclaw token --for claude     # Print a ready-to-paste Claude Desktop config
```

### `synap openclaw setup-domain`

Expose the OpenClaw dashboard at a public HTTPS URL.

- **Managed pods** (`*.synap.live`): calls the CP to create a DNS A record automatically (`openclaw.yourpod.synap.live`), wires Caddy's `forward_auth` to validate your existing Synap session cookie. Zero manual auth.
- **Self-hosted**: prompts for a subdomain, tells you which DNS A record to add, generates a random 32-char password, and writes a Caddy basic-auth gate. Hashes via `caddy hash-password` — no bcrypt dependency.

Both modes forge `X-Real-IP: 127.0.0.1` at the Caddy layer so OpenClaw treats requests as loopback and skips device pairing. Auth is enforced at the Caddy layer.

### `synap openclaw doctor`

Thin wrapper around OpenClaw's own diagnostic. Use `--fix` to auto-repair known issues.

```bash
synap openclaw doctor
synap openclaw doctor --fix
```

### `synap openclaw logs`

```bash
synap openclaw logs              # Last 50 lines
synap openclaw logs -n 200       # More
synap openclaw logs -f           # Follow
```

### `synap openclaw restart`

Restart the container. Handy after config changes.

---

## Top-level commands

### `synap status`

Health check across the stack: pod, OpenClaw, auth, skill, Intelligence Service.

### `synap login`

```bash
synap login                      # Opens browser
synap login --token <token>      # Headless / server
```

Token: [synap.live/account/tokens](https://synap.live/account/tokens). Your session auto-refreshes for 7 days.

### `synap logout`

### `synap connect`

Re-connect to an existing pod without running the full init wizard.

### `synap update`

Update the synap skill in OpenClaw to the latest version.

### `synap security-audit`

Check OpenClaw + Synap config for known security issues. `--fix` auto-repairs fixable ones.

---

## Why split `synap openclaw configure` from `openclaw configure`?

We delegate to OpenClaw's own config system for the actual write (`openclaw config set env.ANTHROPIC_API_KEY …`) but wrap it for:

1. **Docker exec** — handles the `docker exec openclaw …` for you
2. **Restart** — auto-restarts the container (Docker mode has no hot-reload)
3. **Scripted mode** — `--provider` / `--key` flags for automation
4. **Integration with `synap finish`** — part of the one-shot flow

For anything we don't wrap, use OpenClaw directly:
```bash
docker exec -it openclaw openclaw configure   # Interactive wizard
docker exec openclaw openclaw config get <key>
docker exec openclaw openclaw skills list
docker exec openclaw openclaw channels add --channel telegram --token ...
```

`synap` owns: Synap pod connection, skill install, Caddy proxy auth, CP DNS provisioning.
`openclaw` owns: models, skills, channels, daemon, gateway config.

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
3. Select your pod — CLI handles everything
4. `synap finish` — offers public domain automatically

---

## Troubleshooting

**"Could not reach pod"**
Pod unreachable. Check `synap status` and docker compose.

**"OpenClaw is not running yet"**
First boot takes 1–2 minutes. Wait, then `synap finish`.

**"AI provider not configured"**
Run `synap openclaw configure` — or use `synap openclaw configure --interactive` to hand off to OpenClaw's own wizard.

**MCP client doesn't show tools**
Run `synap openclaw token --for claude` to get a ready-to-paste config with the token pre-filled. Restart your AI client.

**Dashboard: "device approval required"**
Shouldn't happen — `synap openclaw setup-domain` forges `X-Real-IP: 127.0.0.1` so OpenClaw treats Caddy traffic as loopback. If it does, run `synap openclaw doctor --fix`.

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
