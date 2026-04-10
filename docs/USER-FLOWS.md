# Synap CLI — User Flows Specification

**Version:** 1.0 — Validated 2026-04-04

---

## Entry Point

```bash
npx @synap/cli init     # zero-install, runs immediately
npm i -g @synap/cli     # global install for regular use
synap init              # after global install
```

---

## Flow Detection Logic

```
1. Check: Does ~/.openclaw/ exist AND is OpenClaw installed?
   ├── YES → PATH A (existing OpenClaw user — primary funnel)
   └── NO  → Check: Are we on a server (Linux + Docker available)?
             ├── YES → PATH B (fresh server setup)
             └── NO  → PATH C (laptop/desktop user)
```

Detection heuristics:
- OpenClaw: `~/.openclaw/` directory exists, `openclaw --version` responds
- Server: `uname -s` = Linux, `docker info` succeeds, not macOS desktop
- Resources: `free -m` for RAM, `df -h` for disk

---

## PATH A: Existing OpenClaw User (250K+ audience)

**Who:** Developer with OpenClaw on a Mac Mini, Hetzner VPS, Raspberry Pi, etc.
**Goal:** Better memory for their agent. Zero migration.

### Step 1: Detect & Report

```
Detecting OpenClaw...
  ✓ OpenClaw v2026.3.31 found at ~/.openclaw
  ✓ Gateway running on port 18789
  ✓ Channels: Telegram, CLI
  ✓ Model: Claude Sonnet 4.6 via Anthropic
  ✓ 3 skills installed
```

### Step 2: Security Audit

```
Security Audit (9 checks):
  ✓ Gateway bound to loopback
  ✓ Token auth enabled
  ✗ OpenClaw version needs update — CRITICAL
  ...
  Score: B — Auto-fix 2 issues? [Y/n]
```

### Step 3: Pod Location

```
Where should your Synap pod run?

  [1] This machine (docker-compose alongside OpenClaw) — FREE
  [2] Managed by Synap (we host it) — €15/mo
  [3] I already have a pod (enter URL + API key)
```

**If [1] selected — resource check:**
```
Checking server resources...
  RAM:  8GB total, 5.2GB available — ✓ sufficient (need ~1.5GB)
  Disk: 80GB total, 52GB free     — ✓ sufficient (need ~5GB)
  Ports: 4000, 5432, 8108 available — ✓ no conflicts

Ready to install. This will run:
  • PostgreSQL 16 + pgvector
  • Typesense search
  • MinIO storage
  • Synap backend

Proceed? [Y/n]
```

**If resources insufficient:**
```
⚠ Your server has 2GB RAM — Synap needs ~1.5GB alongside OpenClaw.
  Performance may be degraded.

  [1] Install anyway (not recommended)
  [2] Use a managed pod instead — €15/mo (recommended)
  [3] Cancel
```

### Step 4: Install Skill

```
Installing synap skill...
  ✓ synap — knowledge graph + message relay + governance
```

### Step 5: Seed Entities

```
Seeding workspace from OpenClaw config...
  ✓ Agent: OpenClaw Agent v2026.3.31 (Telegram, CLI)
  ✓ Skill: synap (infrastructure, verified)
  ✓ Skill: web-search (community)
  ✓ Skill: github-integration (community)
  ✓ Provider: Anthropic (Claude Sonnet 4.6, healthy)
  Created 5 entities
```

### Step 6: AI Provider (Optional)

```
Use Synap as your AI provider?

  Current: Claude Sonnet via Anthropic API (~$150-300/mo)
  With Synap IS: 90% routed to free/cheap models (~$30-50/mo)

  Enable? [y/N]
```

### Summary

```
═══════════════════════════════════════════
  Synap Setup Complete
═══════════════════════════════════════════

  Pod:     http://localhost:4000 (self-hosted)
  Skill:   synap (knowledge graph + relay)
  Entities: 5 seeded from OpenClaw config
  Security: Score A (all checks passed)

  Your agent now has:
    • Structured entity memory (replaces MEMORY.md)
    • Full audit trail (event chain)
    • AI governance (proposal system)
    • Full-text + semantic search

  Try it: ask your agent "remember that Marc prefers email"
  Status: synap status
  Audit:  synap security-audit
═══════════════════════════════════════════
```

---

## PATH B: Fresh Server (No OpenClaw)

**Who:** Developer with a VPS who wants the full stack.
**Goal:** Pod + OpenClaw in one setup.

### Step 1: Resource Check

```
Checking server resources...
  RAM:  8GB — ✓ sufficient
  Disk: 80GB — ✓ sufficient
  Docker: ✓ installed
```

### Step 2: What to Install

```
What would you like to set up?

  [1] Synap pod + OpenClaw (full stack) — recommended
  [2] Synap pod only (add OpenClaw later)
```

### Steps 3-6: Same as Path A

Pod install → Security audit → Skill → Seed → IS provider → Summary

---

## PATH C: Laptop/Desktop User

**Who:** Developer on a MacBook who wants to try Synap.
**Goal:** Get a pod running somewhere and connect.

### Step 1: Options

```
You need a server to run Synap. Options:

  [1] Create a managed server — €15/mo
      Includes: Synap pod + OpenClaw, EU or US hosting
      → Opens synap.live in your browser

  [2] I have a VPS — give me the install command
      → SSH into your server and run:
        curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash
      → Then re-run: synap init --pod-url https://your-domain.com

  [3] I have an existing pod (enter URL + API key)
      → Connect your local OpenClaw (if installed) to the remote pod
```

**If [3] and local OpenClaw detected:**
- Security audit on local OpenClaw
- Install synap skill locally
- Connect to remote pod
- Seed entities

---

## Post-Init Commands

```bash
synap status            # Pod health, OpenClaw health, entity count, security score
synap security-audit    # Full 9-point CVE check
synap security-audit --fix  # Auto-fix what's possible
synap update            # Update synap skill
synap connect           # Quick-connect (skip full init)
```

---

## Phase 2 (Future — after 20+ installs)

- `synap init` with CP auth (browser login → managed pod creation)
- `synap pod migrate --to managed` (export + provision + switch)
- `synap is stats` (token usage, cost savings)
- Per-token billing visibility in `synap status`
