# CLI-bundled skills (`synap skill add bundled`)

This directory must NOT hold hand-authored copies of the backend **SSOT** skills.
The pod's baseline skills already reach every pod two other ways:

- **Auto-seeded** on pod boot by `ensureSystemSkills()` (backend `skills/` → `system/*` rows).
- Shipped as **Agent-Skills packages** by `scripts/sync-skills.sh` (→ `synap-cli/skills/`).

Duplicating them here is what drifted (e.g. an old CRM `digesting-a-channel`), so the
15 SSOT-covered skills were retired from this bundle.

What remains here, and why:
- **CLI/agent-runtime skills** (`coordinating-*`, `authoring-*`) — genuine runtime
  concerns with no SSOT counterpart. Hand-authored; this is their home.
- **Agency/domain skills** (`stellar-scf-grants-advisor` + its reference corpus,
  `mapping-the-server`, `routing-to-channels`, `bookmark-enrichment`,
  `reading-client-progress`) — these belong in the **CP capability templates** and
  are applied via `/capabilities/apply` (see `bridge-setup` AGENCY plan). They stay
  bundled here TEMPORARILY until CP gains reference-corpus support (`documents[]`/
  `referenceDir`) so the stellar corpus survives the move. Do not add new SSOT-style
  skills here.
