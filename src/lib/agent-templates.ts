/**
 * Agent skill templates — pre-canned routing instructions that tell an agent
 * which Synap workspaces to use for its own memory vs. shared product output.
 *
 * Each template generates a CONTEXT.md file injected into the surface's
 * skills directory (or ~/.synap/contexts/<surface>.md for MCP-only surfaces).
 */

export interface WorkspaceRef {
  id: string;
  name: string;
}

export interface ContextParams {
  agentType: string;
  podUrl: string;
  memoryWorkspace?: WorkspaceRef;
  productWorkspaces: WorkspaceRef[];
}

export interface AgentTemplate {
  id: string;
  label: string;
  description: string;
  generateContext(params: ContextParams): string;
}

// ─── Shared rendering helpers ─────────────────────────────────────────────────

function header(agentType: string, podUrl: string): string {
  return `# Synap Agent Context — ${agentType}

Pod: ${podUrl}`;
}

function renderProductBlock(productWorkspaces: WorkspaceRef[], emptyText: string): string {
  return productWorkspaces.length
    ? productWorkspaces.map((w) => `- **${w.name}** (\`${w.id}\`)`).join("\n")
    : emptyText;
}

function renderMemoryBlock(memoryWorkspace: WorkspaceRef | undefined, emptyText: string): string {
  return memoryWorkspace
    ? `**${memoryWorkspace.name}** (\`${memoryWorkspace.id}\`)`
    : emptyText;
}

// ─── Built-in templates ───────────────────────────────────────────────────────

const DEVELOPER: AgentTemplate = {
  id: "developer",
  label: "Developer",
  description: "Code decisions, architecture, gotchas → product workspace; lessons → memory",
  generateContext({ agentType, podUrl, memoryWorkspace, productWorkspaces }) {
    const productBlock = renderProductBlock(productWorkspaces, "_None configured — use pod-wide captures._");
    const memoryBlock = renderMemoryBlock(memoryWorkspace, "_No dedicated memory workspace — use ephemeral memory only._");

    return `${header(agentType, podUrl)}

## Workspace routing

### Your memory workspace (private to you)
${memoryBlock}

Store here:
- Engineering gotchas you discovered (\`synap capture --type gotcha\`)
- Patterns and conventions that proved useful
- Decisions you made and why (even small ones)
- Things to check next session before starting

Run \`synap recall "topic" --structured\` at the start of each session to surface prior knowledge.

### Product workspace(s) (shared with the team)
${productBlock}

Write here when:
- You make a significant architectural or design decision
- You discover a non-obvious principle about this codebase
- There is a new convention the team should follow
- A change in direction is worth documenting for the record

Use \`synap capture --type decision\` or \`synap capture --type lesson\` for these.

## Operating discipline
1. Always call \`synap orient\` first to discover available workspace IDs.
2. Search before creating: \`synap recall "topic"\` and \`synap search "query"\`.
3. Link every entity you create to at least one related entity.
4. Never leave a session without persisting something useful.
`;
  },
};

const RESEARCHER: AgentTemplate = {
  id: "researcher",
  label: "Researcher",
  description: "Research findings, sources, conclusions → product workspace; notes → memory",
  generateContext({ agentType, podUrl, memoryWorkspace, productWorkspaces }) {
    const productBlock = renderProductBlock(productWorkspaces, "_None configured._");
    const memoryBlock = renderMemoryBlock(memoryWorkspace, "_No dedicated memory workspace._");

    return `${header(agentType, podUrl)}

## Workspace routing

### Your memory workspace
${memoryBlock}

Store here:
- Ongoing research threads (status: ongoing → concluded)
- Sources you have already read (avoid re-fetching)
- Personal notes and intermediate findings

### Product workspace(s)
${productBlock}

Write here when:
- A research thread reaches a conclusion — create a \`research\` entity with conclusion + confidence
- A question gets answered — update \`question.questionStatus = "answered"\`
- A decision is made based on findings — create a \`decision\` entity linked to the question

## Research flow
question → research (ongoing) → research (concluded) → decision → tasks
Link each stage: \`research.questionId\`, \`decision.projectId\`.
`;
  },
};

const ASSISTANT: AgentTemplate = {
  id: "assistant",
  label: "Assistant",
  description: "General-purpose agent with shared memory and product workspaces",
  generateContext({ agentType, podUrl, memoryWorkspace, productWorkspaces }) {
    const productBlock = renderProductBlock(productWorkspaces, "_None configured._");
    const memoryBlock = renderMemoryBlock(memoryWorkspace, "_No dedicated memory workspace._");

    return `${header(agentType, podUrl)}

## Workspace routing

### Your memory workspace
${memoryBlock}

Use for: preferences, recurring context, things to remember across sessions.

### Shared workspace(s)
${productBlock}

Use for: tasks, notes, and documents the user should see.

## Defaults
- Prefer structured entities (\`note\`, \`task\`, \`decision\`) over raw memory.
- Always orient first (\`synap orient\`).
- Link everything — isolated entities have no value in a knowledge graph.
`;
  },
};

const MINIMAL: AgentTemplate = {
  id: "minimal",
  label: "Minimal (identity only)",
  description: "No routing rules — just establishes agent identity on the pod",
  generateContext({ agentType, podUrl }) {
    return `${header(agentType, podUrl)}

This agent has a dedicated identity on this pod.
Use \`synap orient\` to discover available workspaces and profiles.
`;
  },
};

export const AGENT_TEMPLATES: AgentTemplate[] = [
  DEVELOPER,
  RESEARCHER,
  ASSISTANT,
  MINIMAL,
];

export function getTemplate(id: string): AgentTemplate {
  return AGENT_TEMPLATES.find((t) => t.id === id) ?? MINIMAL;
}
