# @synap-core/cli

Connect [OpenClaw](https://github.com/openclaw/openclaw) to your Synap pod — sovereign knowledge infrastructure for AI agents.

```bash
npx @synap-core/cli init
```

---

## What it does

`synap init` walks you through three paths depending on your setup:

| Path | When to use |
|------|-------------|
| **A** — Existing OpenClaw | OpenClaw is already running, just connect it to Synap |
| **B** — Fresh install | No OpenClaw yet — generates config, you run `openclaw --config synap.json` |
| **C** — Managed pod | Point to your Synap cloud pod, CLI handles everything |

After init, your AI agent gets structured memory (entities, relationships, full-text search, knowledge graph) via the `synap` OpenClaw skill.

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

## Commands

### `synap init`

Full setup wizard. Detects OpenClaw, connects to a pod, installs the skill, seeds the Agent OS workspace.

```bash
synap init
```

If OpenClaw is being provisioned on a managed server, setup may take a few minutes. Run `synap finish` once it's ready.

---

### `synap finish`

Complete the setup after OpenClaw has started (managed pod path). Installs the skill, seeds entities, configures the intelligence service.

```bash
synap finish
```

Run this after `synap init` if prompted — it's the second half of the managed pod flow.

---

### `synap status`

Show the health of your entire stack at a glance.

```bash
synap status
```

Output covers:
- **Account** — login state, token expiry
- **OpenClaw** — local running state, or remote provisioning state on your pod
- **Synap Pod** — URL, health, version
- **Workspace Config** — workspace ID, agent user, when config was saved
- **Intelligence Service** — whether AI is provisioned
- **Synap Skill** — whether the skill is installed in OpenClaw
- **Next Steps** — what to do next

---

### `synap login`

Sign in to your Synap account. Required for managed pod flows.

```bash
synap login                      # Opens browser
synap login --token <token>      # Headless / server environments
```

For servers without a browser, generate a token at [synap.live/account/tokens](https://synap.live/account/tokens) and use `--token`.

Your session is kept alive automatically — as long as `synap status` or `synap init` succeeds at least once every 7 days, you won't need to re-login.

---

### `synap logout`

Remove stored credentials.

```bash
synap logout
```

---

### `synap connect`

Connect to a pod that was already provisioned (skip the full init wizard).

```bash
synap connect
```

---

### `synap security-audit`

Check your OpenClaw + Synap config for common security issues (API key exposure, outdated versions, HTTPS enforcement, etc.).

```bash
synap security-audit
synap security-audit --fix    # Auto-fix what's fixable
```

Example output:

```
  ✓ Gateway bound to loopback
  ✓ Token authentication enabled
  ✗ OpenClaw version 2026.2.x — CRITICAL (9.9 CVSS)
  ✓ No plaintext credentials
  ✗ ~/.openclaw world-readable
  ✓ WebSocket origin validation
  ✓ Dangerous skill scanner
  ✓ Workspace filesystem access
  ✓ Exec approval gates

  Score: B  (2 issues, 1 critical)
```

---

### `synap update`

Update the Synap skill in your OpenClaw installation to the latest version.

```bash
synap update
```

---

## Configuration

The CLI stores config in `~/.synap/` (user-only, `chmod 600`):

| File | Contents |
|------|----------|
| `credentials.json` | CP auth token |
| `pod-config.json` | Pod URL, workspace ID, agent user ID, Hub API key |

Never commit these files.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNAP_CP_URL` | `https://api.synap.live` | Control plane API URL |
| `SYNAP_LANDING_URL` | `https://synap.live` | Landing page URL (for OAuth callback) |

---

## How the skill works

The `synap` OpenClaw skill gives your AI agents access to Synap's Hub Protocol:

| What | How the agent uses it |
|------|----------------------|
| Store a memory | Save a fact — keyword or semantic search |
| Search memories | Find relevant facts across everything stored |
| Create an entity | Structured object (person, task, note, project, …) |
| Search entities | Find by name, type, or content |
| Send a message | Post to any channel |
| Create a proposal | Propose a change for human review |

Agents self-discover available entity types and views at runtime — no hardcoding.

---

## Deployment paths

### Self-hosted (free)

```bash
git clone https://github.com/synap-core/synap-backend
cd synap-backend
docker compose --profile openclaw up -d
# then:
synap init  # → "Connect to existing pod"  → http://localhost:4000
```

### Managed pod ($15–20/mo)

1. Create a pod at [synap.live](https://synap.live)
2. Run `synap init` → "Connect to my Synap cloud pod"
3. Select your pod — CLI handles provisioning

---

## Troubleshooting

**"Could not reach pod"**
Check that your pod URL is reachable. For self-hosted, make sure Docker Compose is up and port 4000 is accessible.

**"No workspace found on this pod"**
The CLI auto-creates an Agent OS workspace on first connect. Re-run `synap init` — it's idempotent.

**"OpenClaw provisioning error"** (managed pod, `serverIp null`)
Your managed pod doesn't have a registered server IP (trial pods). Install OpenClaw locally instead:
```bash
npm i -g openclaw
synap init  # → Path A
```

**Login on a remote server (no browser)**
```bash
synap login --token <your-token>
# Generate token at: https://synap.live/account/tokens
```

**"Session expired" in synap status**
Run `synap login` again. In normal use the session auto-refreshes and you should only need to login once.

---

## Why Synap

- **Structured memory**: OpenClaw's `MEMORY.md` is flat files. Synap gives you PostgreSQL + pgvector + Typesense — entities, relationships, full-text + semantic search.
- **Governance**: AI agent mutations go through proposals — reviewable, reversible, auditable.
- **Sovereign**: Self-host for free. Your data stays on your infrastructure.

---

## License

MIT
