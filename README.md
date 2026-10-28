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
synap login                      # Prints a sign-in link and code, opens the browser when it can
synap login --reconnect [name]   # Re-authenticate a saved pod without re-entering its URL
```

No browser on this machine (SSH, a server)? Open the printed link on any device and enter the code. Your session auto-refreshes for 7 days.

### `synap connect`

Re-connect an agent to an existing pod without running the full init wizard (`synap connect --target=claude-code`).

### `synap playbook run <name-or-id>`

Start a governed process in one step: `synap playbook run "Design to implementation" --subject <entityId> --param goal="..." [--json]`.
A name resolves through the pod's playbook list (ambiguous or unknown names are refused, candidates listed); `--param` is typed by the playbook's declared params; a required param left out is asked of you by the run, not refused. An agent's run usually comes back as a proposal: that is success, printed with its review link (`synap open proposal <id>`). Same door as MCP `synap_run_playbook`.

### Wake: sessions that message each other

An agent working one of your sessions can message the agent of another (`blocked_on_you`, `handoff`, `done`, `fyi`). A Claude Code terminal is idle between turns, so the CLI wakes it with a Claude Code `asyncRewake` Stop hook:

```bash
synap hooks install-wake            # this project's .claude/settings.json (synap init does it when it connects Claude Code)
synap hooks install-wake --user     # every project (~/.claude/settings.json)
synap hooks install-wake --uninstall
synap session attach <sessionId>    # the session this terminal wakes for
```

The hook runs `synap session wait --hook` after every turn. It waits on the session's change feed and exits 2, which Claude Code reads as "wake the model with this", when one of these arrives: another session's agent hands this one work or is blocked on it, or you answer or write in the session's room. Anything else exits 0 and wakes no one: a timeout, no attached session, a failure, or a `claude -p` run (Claude Code runs the hook in the foreground there). `fyi` and `done` never wake. They ride along with the next wake. The text arrives fenced, as data and never as instructions, followed by the exact reply:

```bash
synap session post <senderSessionId> --cause <messageId> --intent done "Keys are in the vault."
```

`--cause` names the message that woke you. The pod counts on it to stop two agents waking each other forever: a reply chain wakes at most once, and a pair of sessions wakes each other at most 3 times per 10 minutes. The same feed outside a hook: `synap session wait <id> --events session_message,answer [--wake-only] [--json] [--once]`. A pod that does not deliver agent messages yet says so instead of waiting. The hook then waits on your answers only.

---

## Configuration files

Stored in `~/.synap/` (user-only, `chmod 600`):

| File | Contents |
|---|---|
| `credentials.json` | CP auth token |
| `config.json` | Saved pods (URL, workspace ID, agent user ID, Hub API key), the active pod, per-agent keys. Replaces the older `pod-config.json`, which is migrated on first read |

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

On the server (Linux, a domain pointing at it; the installer needs root to set up Docker):

```bash
curl -fsSLo synap-install.sh https://github.com/synap-core/backend/releases/download/channel-stable/install.sh
less synap-install.sh   # read it first
sudo bash synap-install.sh --domain <pod.your-domain.com> --email <you@your-domain.com>
```

Then, on your computer:

```bash
synap init --pod-url https://<pod.your-domain.com>
```

Full guide: [deploy/README.md](https://github.com/Synap-core/backend/blob/main/deploy/README.md).

### Managed pod (private beta)

1. Join the waitlist at [synap.live](https://synap.live); once you are in, create your pod there
2. `synap init` and select your pod — the CLI handles the rest

---

## Troubleshooting

**"Could not reach pod"**
Pod unreachable. Check `synap status` and docker compose.

**"Session expired" in synap status**
Run `synap login` and open the printed link on any device.

---

## Why Synap

- **Structured memory**: not flat files. PostgreSQL + pgvector + Typesense. Entities, relationships, full-text + semantic search.
- **Governance**: AI mutations go through reviewable proposals.
- **Sovereign**: self-host for free, your data stays yours.

---

## License

[MIT](LICENSE)
