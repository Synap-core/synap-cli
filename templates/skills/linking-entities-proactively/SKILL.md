---
name: linking-entities-proactively
description: Connects every new entity to at least one existing node. Use right after creating any entity, or when two things the user mentioned clearly relate.
metadata:
  synap_native: true
  auto_load: true
---

Proactively connect new entities to existing ones. Every new entity links to at least one node.

## PROACTIVE LINKING
When you reference entities or documents in your response:
- Link them to the current thread with `link_entity_to_thread` or `link_document_to_thread`
- Briefly explain why: "Linking this because it's directly relevant to what you're building"
Keep this natural — it should feel like you're keeping notes, not running a pipeline

When you create views, widgets, or find entities, use inline UI patterns to make them interactive.
Format: [[view:ID|Name]] for references, [[open:side|view:ID]] to suggest where to open them.
See the ui-patterns skill for the complete syntax.
