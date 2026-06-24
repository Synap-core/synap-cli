---
name: understanding-the-capability-architecture
description: Understands Synap's capability-skill-tool architecture and knows when to propose new capabilities, skills, or connection tools. Use when discovering what the agent can do, when the user asks to automate something or connect a service, or when a recurring pattern suggests a reusable capability.
metadata:
  synap_native: true
  auto_load: true
---

## Synap Capability Architecture — How Everything Connects

Synap is built on three composable primitives. Understanding their relationship lets you propose new combinations that compound over time.

### The Three Primitives

| Primitive | What it is | Examples |
|---|---|---|
| **Capability** | A named CONTAINER. Groups skills + tools under one deployable bundle. Think of it as "a thing your agents can do." | `Discord Channel Ingest`, `Nango — Gmail`, `Agency — AI Know-How` |
| **Skill** | AI know-how. `instruction` skills = prompt text (documentation, methodology, rules). `code` skills = sandboxed JS functions (executable tools). | `stellar-scf-grants-advisor`, `investigating-before-answering` |
| **Tool / Connection** | External service connector. A Nango provider, an API key credential, or a built-in Synap tool. | `nango-gmail`, `generic-apikey`, `discord` |

### How They Compose

```
Capability "Nango — Gmail"
├── Tool: nango-gmail (connection — the OAuth provider)
├── Skill: gmail-compose (instruction — how to compose effective emails)
└── Skill: gmail-label-automation (code — auto-label incoming mail)

Capability "Stellar SCF Grants Advisor"  
├── Skill: stellar-scf-grants-advisor (instruction — the methodology)
└── Documents: reference docs loaded via get_document() (on-demand details)
```

A capability IS its parts. The parts attach via `member_of` links in the `links` table. The same skill can `member_of` multiple capabilities — they're composable, not exclusive.

### When To Propose Each

**Propose a standalone SKILL when:**
- You discover a repeatable methodology the agent should follow (a workflow, a scoring system, a rule set)
- You notice the agent making the same kind of error repeatedly (→ a guardrail skill)
- The user asks for a specific kind of analysis or output format consistently
- Use `create_skill` to propose it

**Propose a CAPABILITY when:**
- A skill needs an external connection to be useful (email → needs Gmail, calendar → needs Google Calendar)
- You're bundling multiple skills that work together toward one goal
- The user asks to "connect" a service (Discord, Gmail, LinkedIn, etc.)
- Use `list_capabilities` to see existing containers, then propose a new one if needed

**Propose a CONNECTION / TOOL when:**
- The user wants to connect an external service (Nango provider, API key)
- A capability is missing its execution layer
- Use `connect_service` to start the OAuth flow

### Discovery Before Proposal

Before proposing ANYTHING new, discover what already exists:

1. `list_capabilities` → what bundles are already ready?
2. `list_profiles` → what entity types exist? Could the skill operate on existing data?
3. `search_unified` → are there already skills/docs covering this?
4. `suggest_skill <topic>` → search the skill knowledge base

### The Compound Effect

The architecture compounds: each new skill or capability builds on existing ones. A skill that teaches the agent to write client emails → can be combined with the Nango-Gmail capability → becomes a deployable client-communication bundle. The skill written once is reusable in multiple capabilities.

**You are an active participant in this architecture.** When you recognize a pattern that should be a reusable skill or capability, propose it. Don't wait to be asked. The system gets richer with every well-scoped skill you create.
