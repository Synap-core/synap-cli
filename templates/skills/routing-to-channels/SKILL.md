---
name: routing-to-channels
description: Routes a message to the right channel and creates a channel when warranted. Use when a message belongs in a different channel, or a new room or thread should be created.
metadata:
  synap_native: true
  auto_load: false
---

Route messages to the right channel. Understand channel types (personal, group, external).

## CHANNEL ROUTING
When you detect the user is talking about a specific entity (project, task, person, etc.) that has or should have its own channel, use `route_to_channel` to continue the conversation there. This gives you access to the entity's full context and history.

Examples of when to route:
- User asks about "the marketing project" → route to the marketing project's channel
- User discusses a specific task in depth → route to that task's channel
- User mentions a person and wants to plan something → route to that person's channel

Always explain WHY you're routing: "Let me continue this in the Marketing Project channel where I have the full project context."

When routing, ALWAYS set `forwardMessage` to the user's original message so the target channel has full context. This prevents "what were we talking about?" moments — the user's question appears in the target channel as a forwarded message.

Do NOT route when:
- The user asks a quick question you can answer from memory
- The user is browsing/exploring across multiple entities
- You're in a general brainstorming conversation
- The entity doesn't benefit from dedicated context (simple notes, one-off bookmarks)

Route when the conversation will clearly benefit from entity-specific context and history.

## BINDING AN EXTERNAL CHANNEL TO A CLIENT ENTITY

A channel is *bound* when `channels.contextObjectId` points at the entity it belongs to. Once bound, every inbound message on it arrives entity-resolved for free: `external_message.received` carries `subjectId` = the bound entity. Automations (e.g. proactive grant review) rely on this — they resolve the client's **team** channel and dossier from `subjectId`, and skip entirely when a channel is unbound.

### First contact on an UNBOUND external channel (runtime, you the agent)
A channel is still unbound when it has no `contextObjectId` — the tell is that the message's `subjectId` **equals the channel id** (the resolver falls back to the channel id when there is nothing bound). When you see that on an external/inbound channel:

1. **Match an existing client** — `entity.query({ profileSlug: 'client', filter: { ... } })` on the sender's name/handle/domain. Never create a duplicate: bind to the match if one exists.
2. **Create one if there is no match** — a `client` entity (the create-then-configure minimum: just enough to exist).
3. **Bind the channel to it** — `channel.bind({ channelId, contextObjectType: 'entity', contextObjectId: <clientEntityId>, branchPurpose: 'client-comms' })`. The inbound channel mirrors to the client, so it is `client-comms`.

After binding, you are done for every future message: they all arrive entity-resolved, and the team-channel resolution the automations need starts working. Explain the bind briefly, the way you would when keeping notes ("Binding this channel to Acme so everything they send lands on their record.").

**FIREWALL:** binding a channel `client-comms` marks it as mirrored to the client. NEVER post bot/team output to a `client-comms` channel — collaboration goes to the sibling `team` channel (see below). When unsure of a channel's role, bind it `client-comms` (the safe default).

### Onboarding a KNOWN client (you already have, or are creating, the entity)
When you create or onboard a client, wire its channels in the same move so the firewall has both surfaces from day one:

1. **Client-comms channel** — `channel.ensure({ contextObjectType: 'entity', contextObjectId: <clientEntityId>, branchPurpose: 'client-comms' })` (find-or-create). If the client's external channel already exists, `channel.bind(...)` it instead of ensuring a new one.
2. **Team sibling channel** — `channel.ensure({ contextObjectType: 'entity', contextObjectId: <clientEntityId>, branchPurpose: 'team' })`. This is the channel every automation resolves via `channel.resolve({ ..., channelType: 'team' })`. Without it, team-facing posts (grant review flags, digests) have nowhere firewall-safe to land.

Both point at the SAME client entity — one `client-comms`, one `team`. That pairing is what lets bot/team output surface on the team channel and NEVER leak into the client channel.

> Population model: onboarding binds the clients you already know; on-the-fly binding (above) catches the unknown ones on their first inbound message. Together they cover the whole roster.
