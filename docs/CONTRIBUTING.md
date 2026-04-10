# Contributing to @synap-core/cli

## Setup

```bash
git clone https://github.com/Synap-core/synap-cli.git
cd synap-cli
npm install          # or pnpm install
npm run build        # compile TypeScript → dist/
```

Run locally without installing:
```bash
node dist/index.js status
node dist/index.js init
```

Or use tsx for instant iteration (no compile step):
```bash
npx tsx src/index.ts status
```

---

## Project structure

```
src/
  index.ts               # CLI entry — Commander.js command registration
  commands/
    init.ts              # synap init  (full wizard, ~900 lines)
    finish.ts            # synap finish (post-provisioning second pass)
    connect.ts           # synap connect (quick-connect, no wizard)
    status.ts            # synap status
    security-audit.ts    # synap security-audit
    update.ts            # synap update
  lib/
    auth.ts              # CP login, token storage, isLoggedIn(), loginWithToken()
    pod.ts               # Pod health, LocalPodConfig, setup/agent API calls
    openclaw.ts          # detectOpenClaw(), skill install/update
    hardening.ts         # Security check definitions + scoring
  utils/
    logger.ts            # log.success / log.warn / log.error / log.dim / banner()
dist/                    # Compiled output (gitignored)
docs/
  USER-FLOWS.md          # UX spec for all three init paths
  CONTRIBUTING.md        # This file
```

---

## Commit conventions

Follow the existing pattern: `type(scope): description`

```bash
git commit -m "feat(init): add --skip-seed flag to init command"
git commit -m "fix(auth): don't delete token on local expiry"
git commit -m "chore: bump version to 0.2.1"
git commit -m "docs: update README troubleshooting section"
```

Common types: `feat`, `fix`, `chore`, `refactor`, `docs`  
Common scopes: `init`, `auth`, `status`, `finish`, `connect`, `pod`, `cli`

---

## Versioning

We follow [semver](https://semver.org/):

| Change | Version bump |
|--------|-------------|
| Bug fix, internal refactor | patch (`0.2.0` → `0.2.1`) |
| New command or flag | minor (`0.2.0` → `0.3.0`) |
| Breaking change to CLI interface | major (`0.2.0` → `1.0.0`) |

Bump the version in `package.json` before publishing:

```bash
# Manually edit package.json "version" field, or use npm:
npm version patch    # 0.2.0 → 0.2.1
npm version minor    # 0.2.0 → 0.3.0
npm version major    # 0.2.0 → 1.0.0
```

`npm version` also creates a git tag automatically.

---

## Publishing to npm

> Requires publish access to the `@synap` org on npm. Ask Antoine for access.

### 1. Make sure the build is clean

```bash
npm run build
# must exit with no errors
```

### 2. Bump the version

```bash
npm version patch    # or minor/major
# This edits package.json and creates a git tag (e.g. v0.2.1)
```

### 3. Commit + push

```bash
git add package.json package-lock.json
git commit -m "chore: release v0.2.1"
git push origin main --follow-tags
```

`--follow-tags` pushes the version tag created by `npm version`.

### 4. Publish

```bash
npm publish --access public
```

For a dry run (see what would be published without actually publishing):
```bash
npm publish --dry-run
```

### 5. Verify

```bash
npm view @synap-core/cli
# should show the new version
npx @synap-core/cli@latest --version
```

---

## Testing changes locally before publishing

Link the package globally so `synap` resolves to your local build:

```bash
npm run build
npm link
synap status          # uses your local dist/
```

Unlink when done:
```bash
npm unlink -g @synap-core/cli
```

---

## Environment variables for local dev

The CLI targets production by default. Override for local testing:

```bash
export SYNAP_CP_URL=http://localhost:3000      # local control plane
export SYNAP_LANDING_URL=http://localhost:5173  # local landing page

node dist/index.js init
```

---

## CP endpoints used by this CLI

| Method | Path | Auth | Used by |
|--------|------|------|---------|
| `GET` | `/auth/me` | Bearer token | `isLoggedIn()` |
| `GET` | `/pods` | Bearer token | Pod list in `init` |
| `POST` | `/pods/handshake-jwt` | Bearer token | `provisionUserOnPod()` |
| `POST` | `/pods/setup-agent` | Bearer token | `setupAgentViaCp()` |
| `GET` | `/openclaw/status?podId=` | Bearer token | `getOpenClawRemoteStatus()` |

Pod endpoints (called directly, Bearer = Hub API key):

| Method | Path | Used by |
|--------|------|---------|
| `GET` | `/api/health` | `checkPodHealth()` |
| `POST` | `/api/handshake` | `provisionUserOnPod()` |
| `POST` | `/api/hub/setup/agent` | `setupAgent()` |
| `GET` | `/api/provision/status` | `synap status` IS section |

---

## Common issues

**`dist/` is stale** — always run `npm run build` before testing a change.

**"Permission denied" on `npm publish`** — run `npm login` and make sure your npm account is in the `@synap` org.

**`npm link` not working** — make sure `dist/index.js` has a shebang (`#!/usr/bin/env node`) and is executable. The `bin` field in `package.json` handles this automatically after `npm link`.

**TypeScript errors after a merge** — run `npm install` first; a dependency may have been added.
