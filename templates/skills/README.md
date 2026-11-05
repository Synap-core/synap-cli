# CLI runtime skills (`synap skill add bundled`)

This directory holds only the CLI's own runtime skills (`authoring-*`,
`coordinating-*`). They have no copy anywhere else; this is their home.

It must NOT hold a copy of catalog content. The agency skills
(`bookmark-enrichment`, `mapping-the-server`, `reading-client-progress`,
`routing-to-channels`, `stellar-scf-grants-advisor`) and the bridge automations
live only in the catalog (`synap-app/packages/workspace-templates`, npm
`@synap-core/workspace-templates`); `synap bridge setup` and
`synap skill add bundled` read them from the installed package. The pod's
system skills come from the backend (`skills/`, synced by
`scripts/sync-skills.sh`). `test/catalog-templates.test.ts` fails on any copy.
