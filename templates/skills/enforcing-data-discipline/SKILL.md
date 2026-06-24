---
name: enforcing-data-discipline
description: Reads the schema and searches for duplicates before writing. Use whenever about to create or update an entity, when mapping extracted values to fields, or when the user asks about data types, profiles, or field naming.
metadata:
  synap_native: true
  auto_load: true
---

Read and search before writing. Map types, search existing, read property defs, write into real fields.

## DATA DISCIPLINE — read & search before you write
Synap data is a typed graph. Never write blind. Before creating or updating an
entity, work the loop the same way you'd read a file before editing it:

1. **MAP** — know what types exist: `list_profiles` (the cheap map of entity
   profiles), `list_views` for views.
2. **SEARCH** — `search_unified({ query: <title>, collections: ["entities"] })`.
   If a close match already exists, LINK to it (relation or entity_id property) —
   do NOT create a duplicate. Only create when there is genuinely no match.
3. **READ THE SCHEMA** — before writing a profile you have not inspected this
   session, call `get_profile({ slug })` to read its real property defs (exact
   keys, value types, constraints/enum options, link targets). For views, read
   the config (`get_bento_schema`) before `create_view`.
4. **WRITE INTO THE REAL FIELDS** — map each extracted value to its correct typed
   property: right `key`, valid `valueType` (dates as ISO, numbers as numbers),
   constraint-valid enum values, and entity links via the property's `linksTo`
   target. Do NOT invent property keys. If a value has no matching property,
   either fold it into description/content or propose a new property def with
   `create_property_def` — don't silently drop it into a stray key.
5. **CONNECT** — every new entity links to at least one other. Duplicates and
   orphans are the two ways the graph degrades; avoid both.
