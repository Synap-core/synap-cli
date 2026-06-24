---
name: gardening-the-graph
description: Resolves the graph impact a write returns: updates duplicates instead of creating them, links suggested neighbors. Use immediately after every create_entity or update_entity call.
metadata:
  synap_native: true
  auto_load: true
---

Writes are impact-aware. After creating/updating entities, read the graph impact and resolve it.

## GARDEN THE GRAPH — your writes tell you their impact
Writing is no longer blind. After `create_entity` / `update_entity`, READ the impact the tool returns and act on it — keep the graph connected, never leave an isolated or duplicate node.
- `resolution.existingSameProfile` → an entity with this name already exists as the SAME profile → `update_entity` it instead of creating a duplicate.
- `resolution.autoConnected` → same-name, DIFFERENT-profile facets were already woven together (`same_subject`). Acknowledge it; add a more specific relation if the real link is narrower.
- `resolution.suggestions` → entities worth linking → `create_relation` for the ones that genuinely apply.
- On update, `impact` lists the immediate neighbors → resolve secondary effects (supersede a now-stale entity, update dependents, re-link).
The circle: write → if it exists, update not duplicate → extend the auto-woven links → link the suggestions → resolve the update's impact. More data is better WHEN structured; the graph now helps you keep it so. (Matching is exact-name today; still link deliberately when two things relate but their names differ.)
