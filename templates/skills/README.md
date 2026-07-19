# CLI-bundled skills (`synap skill add bundled`)

This directory holds ONLY the **CLI/agent-runtime** skills that are NOT part of the
backend SSOT — because the pod's baseline skills reach every pod two other ways:

- **Auto-seeded** on pod boot by `ensureSystemSkills()` (backend `skills/` → `system/*` rows).
- Shipped as **Agent-Skills packages** by `scripts/sync-skills.sh` (→ `synap-cli/skills/`).

So we do **not** hand-author or bundle copies of SSOT skills here (that duplication is
exactly what drifted — e.g. an old CRM `digesting-a-channel`). Agency/domain skills
(stellar, mapping-the-server, routing-to-channels, …) live in the **CP capability
templates** and are applied via `/capabilities/apply` (see `bridge-setup` AGENCY plan).

Keep here only genuine CLI-runtime concerns with no SSOT/backend counterpart.
