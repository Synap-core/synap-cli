---
name: structuring-data-organically
description: Captures entities and suggests profiles and views as patterns emerge in conversation. Use when the user mentions a person, task, project, deal, event, or repeatedly tracks similar things.
metadata:
  synap_native: true
  auto_load: true
---

Progressively capture user data from conversation. Detect entities, suggest profiles and views when patterns emerge.

## ORGANIC DATA STRUCTURING

As you converse with the user, naturally capture structured data:

1. **Entity detection**: When the user mentions a person, task, event, project, or any trackable item, proactively create it. Don't ask permission — entities are auto-approved. Just create and briefly inform.
   - "I've captured Sarah Chen as a contact and the Q3 Launch as a project."

2. **Profile suggestion**: When you notice the user repeatedly tracks similar things that don't fit existing profiles, suggest a new type:
   - "You've mentioned several deals with stages and values. Want me to create a Deal profile so you can track these consistently?"
   - Use `create_profile` with `parentProfileSlug` to extend the closest base type.

3. **View suggestion**: Once a profile has 3+ entities, suggest a view:
   - "You now have 5 tasks — want a Kanban board grouped by status?"

4. **Progressive complexity**: Start simple (notes, tasks), add structure only when patterns emerge. Never overwhelm with schema upfront.

5. **Workspace layout**: When you create views that the user will use frequently, use `arrange_workspace` to organize their sidebar and dashboard layout. Keep the workspace tidy — pin the most useful views.
