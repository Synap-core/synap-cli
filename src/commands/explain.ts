/**
 * synap explain [topic]
 *
 * Static capability map — no network calls needed. Tells any agent starting
 * cold what Synap can do and which CLI command to use for each operation.
 *
 * Usage:
 *   synap explain              # full capability map
 *   synap explain graph        # relations & graph traversal
 *   synap explain memory       # memory & knowledge
 *   synap explain automation   # automations
 *   synap explain agents       # agents & runner
 *   synap explain governance   # proposals & governance
 *   synap explain views        # views & bento
 *   synap explain events       # event chain
 *   synap explain connectors   # connectors
 */

import chalk from "chalk";

export interface ExplainOpts {
  topic?: string;
}

// ── Section renderers ──────────────────────────────────────────────────────────

function sectionEntities(): void {
  console.log(chalk.bold("\n## Entities & Profiles"));
  console.log(chalk.dim("  Every piece of data is an entity with a profile type (schema)."));
  console.log("");
  console.log(`  ${chalk.cyan("synap orient")}               ${chalk.dim("→ see workspaces, profiles, capabilities")}`);
  console.log(`  ${chalk.cyan("synap list profiles")}        ${chalk.dim("→ entity types available in active workspace")}`);
  console.log(`  ${chalk.cyan("synap list entities")}        ${chalk.dim("→ browse entities (--profile, --workspace, --limit)")}`);
  console.log(`  ${chalk.cyan("synap show <id>")}            ${chalk.dim("→ entity detail + all linked relations")}`);
  console.log(`  ${chalk.cyan("synap get entity <id>")}      ${chalk.dim("→ raw entity properties")}`);
  console.log(`  ${chalk.cyan("synap create entity")}        ${chalk.dim("→ --profile task --name 'Fix bug' --props '{}'")}`);
  console.log(`  ${chalk.cyan("synap set entity <id>")}      ${chalk.dim("→ --props '{\"status\":\"done\"}'")}`);
  console.log(`  ${chalk.cyan("synap browse [profile]")}     ${chalk.dim("→ paginated entity list (cleanest UX)")}`);
  console.log(`  ${chalk.cyan("synap ask <query>")}          ${chalk.dim("→ the one read verb — routes across all substrates")}`);
}

function sectionGraph(): void {
  console.log(chalk.bold("\n## Relations & Graph"));
  console.log(chalk.dim("  Entities are connected by typed relations forming a traversable graph."));
  console.log("");
  console.log(`  ${chalk.cyan("synap create relation")}      ${chalk.dim("→ --source <id> --target <id> --type extends")}`);
  console.log(`  ${chalk.cyan("synap graph --entity <id>")}  ${chalk.dim("→ BFS traversal depth 2 (--depth 3 for deeper)")}`);
  console.log(`  ${chalk.cyan("synap show <id>")}            ${chalk.dim("→ entity + its relations in one view")}`);
  console.log("");
  console.log(chalk.dim("  Relation types are workspace-defined. Check your workspace schema for valid types."));
  console.log(chalk.dim("  maxDepth clamped to 3. Response: flat array of entity + relation records."));
}

function sectionMemory(): void {
  console.log(chalk.bold("\n## Memory & Knowledge"));
  console.log(chalk.dim("  Canonical verbs: ask (read) · capture (structured write) · note (quick)."));
  console.log("");
  console.log(`  ${chalk.cyan("synap note <text>")}          ${chalk.dim("→ save a quick note (creates a note entity)")}`);
  console.log(`  ${chalk.cyan("synap ask <query>")}          ${chalk.dim("→ the one read verb — routes semantic/procedural/episodic")}`);
  console.log(`  ${chalk.cyan("synap capture")}              ${chalk.dim("→ structured knowledge: --type gotcha|lesson|decision|reference")}`);
  console.log(`                              ${chalk.dim("     --claim 'text' --why 'context' --tags 'repo:x'")}`);
  console.log(`  ${chalk.cyan("synap context")}              ${chalk.dim("→ session-start: knowledge + proposals + tasks")}`);
  console.log(`  ${chalk.cyan("synap observe write <text>")} ${chalk.dim("→ record user observation (AI-maintained model)")}`);
  console.log(`  ${chalk.cyan("synap observe recall <q>")}   ${chalk.dim("→ search user observations")}`);
}

function sectionEvents(): void {
  console.log(chalk.bold("\n## Events & Event Chain"));
  console.log(chalk.dim("  Every mutation emits a typed event. Subscribe for real-time feeds."));
  console.log("");
  console.log(`  ${chalk.cyan("synap events --entity <id>")} ${chalk.dim("→ recent event history for an entity")}`);
  console.log(`  ${chalk.cyan("synap events --limit 50")}    ${chalk.dim("→ pod-wide recent events")}`);
  console.log(`  ${chalk.cyan("synap subscribe")}            ${chalk.dim("→ NDJSON stream (long-poll, Ctrl+C to stop)")}`);
  console.log(`  ${chalk.cyan("synap subscribe --event proposal.*")}  ${chalk.dim("→ filtered stream")}`);
  console.log("");
  console.log(chalk.dim("  Event shape: { id, type, subjectType, subjectId, userId, workspaceId, data, timestamp }"));
  console.log(chalk.dim("  Query params: subjectId, type, subjectType, fromDate, limit (max 200)."));
}

function sectionAutomation(): void {
  console.log(chalk.bold("\n## Automations"));
  console.log(chalk.dim("  Trigger→filter→action rules. Triggers: event pattern, cron, webhook, manual."));
  console.log("");
  console.log(`  ${chalk.cyan("synap automation list")}      ${chalk.dim("→ list automations (--workspace, --status)")}`);
  console.log(`  ${chalk.cyan("synap automation describe <id>")}`);
  console.log(`  ${chalk.cyan("synap automation create")}    ${chalk.dim("→ --name X --trigger event:entity.* --action notify")}`);
  console.log(`  ${chalk.cyan("synap automation enable <id> / disable <id> / delete <id>")}`);
  console.log(`  ${chalk.cyan("synap automation schema")}    ${chalk.dim("→ fetch DSL schema (AI context)")}`);
  console.log("");
  console.log(chalk.dim("  Action types: notify | channel-message | none"));
  console.log(chalk.dim("  Cron trigger: --trigger cron:0_*_*_*_*   Event: --trigger event:entity.*"));
}

function sectionViews(): void {
  console.log(chalk.bold("\n## Views"));
  console.log(chalk.dim("  Named query + rendering configs over the entity store."));
  console.log("");
  console.log(`  ${chalk.cyan("synap view list")}            ${chalk.dim("→ list views (--workspace)")}`);
  console.log(`  ${chalk.cyan("synap view create")}          ${chalk.dim("→ --type kanban --profile task --name 'My Board'")}`);
  console.log("");
  console.log(chalk.dim("  View types (12):"));
  console.log(chalk.dim("    table | kanban | bento | list | grid | gallery"));
  console.log(chalk.dim("    calendar | masonry | flow | matrix | branch_tree | whiteboard"));
  console.log("");
  console.log(chalk.dim("  Bento views hold a widget arrangement (react-grid-layout)."));
  console.log(chalk.dim("  Each bento widget: { id, kind: view|entity|widget|<custom>, x, y, w, h, config }"));
}

function sectionGovernance(): void {
  console.log(chalk.bold("\n## Proposals & Governance"));
  console.log(chalk.dim("  AI mutations that require approval go through proposals first."));
  console.log("");
  console.log(`  ${chalk.cyan("synap proposals list")}       ${chalk.dim("→ pending proposals (--workspace, --limit)")}`);
  console.log(`  ${chalk.cyan("synap proposals approve <id>")} ${chalk.dim("→ --reason 'text'")}`);
  console.log(`  ${chalk.cyan("synap proposals reject <id>")} ${chalk.dim("→ --reason 'text'")}`);
  console.log("");
  console.log(chalk.dim("  When a mutation is gated: response.status = 'proposed', response.proposalId set."));
  console.log(chalk.dim("  Proposals are reversible — approve, reject, or revert after execution."));
}

function sectionConnectors(): void {
  console.log(chalk.bold("\n## Connectors"));
  console.log(chalk.dim("  39 Nango-powered integrations: Google, GitHub, Notion, Linear, Slack, Jira, …"));
  console.log("");
  console.log(`  ${chalk.cyan("synap tools list")}            ${chalk.dim("→ available tools + connection status")}`);
  console.log(`  ${chalk.cyan("synap tools connect [name]")}   ${chalk.dim("→ connect a credential to a tool")}`);
  console.log(`  ${chalk.cyan("synap tools sync <provider>")}  ${chalk.dim("→ trigger manual sync")}`);
  console.log(`  ${chalk.cyan("synap tools disconnect <provider>")}`);
  console.log(`  ${chalk.cyan("synap tools schema")}          ${chalk.dim("→ supported providers + field mapping (AI context)")}`);
}

function sectionAgents(): void {
  console.log(chalk.bold("\n## Agents"));
  console.log(chalk.dim("  Named agent identities (separate keys) + autonomous runner + recurring schedules."));
  console.log("");
  console.log(`  ${chalk.cyan("synap agents list")}          ${chalk.dim("→ configured agent identities")}`);
  console.log(`  ${chalk.cyan("synap agents create")}        ${chalk.dim("→ --template twin|assistant|custom --name X")}`);
  console.log(`  ${chalk.cyan("synap agents add")}           ${chalk.dim("→ register pre-existing credential")}`);
  console.log(`  ${chalk.cyan("synap agent run")}            ${chalk.dim("→ --goal 'text' --persona researcher")}`);
  console.log(`  ${chalk.cyan("synap agent schedule")}       ${chalk.dim("→ --goal X --name Y --every daily")}`);
  console.log(`  ${chalk.cyan("synap agent tick")}           ${chalk.dim("→ run due schedules (wire to crontab)")}`);
  console.log("");
  console.log(chalk.dim("  Persona types: researcher | assistant | developer"));
  console.log(chalk.dim("  Model alias: synap/advanced (default). Pass --model to override."));
}

function sectionQuickRef(): void {
  console.log(chalk.bold("\n## CLI Quick Reference"));
  console.log("");
  console.log(chalk.dim("  Auth & setup"));
  console.log(`  ${chalk.cyan("synap pods list / add / use <name>")}`);
  console.log(`  ${chalk.cyan("synap use <workspace-id>")}   ${chalk.dim("→ set active workspace")}`);
  console.log(`  ${chalk.cyan("synap orient")}               ${chalk.dim("→ who am I, what workspaces, capabilities")}`);
  console.log("");
  console.log(chalk.dim("  Data"));
  console.log(`  ${chalk.cyan("synap browse [profile]")}  ${chalk.cyan("synap show <id>")}  ${chalk.cyan("synap ask <q>")}`);
  console.log(`  ${chalk.cyan("synap create entity")}  ${chalk.cyan("synap set entity <id>")}`);
  console.log(`  ${chalk.cyan("synap note <text>")}  ${chalk.cyan("synap capture --type lesson")}`);
  console.log("");
  console.log(chalk.dim("  Graph"));
  console.log(`  ${chalk.cyan("synap graph --entity <id> [--depth 2]")}`);
  console.log(`  ${chalk.cyan("synap create relation --source X --target Y --type related_to")}`);
  console.log("");
  console.log(chalk.dim("  Events"));
  console.log(`  ${chalk.cyan("synap events --entity <id>")}`);
  console.log(`  ${chalk.cyan("synap subscribe [--event proposal.*]")}`);
  console.log("");
  console.log(chalk.dim("  Governance"));
  console.log(`  ${chalk.cyan("synap proposals list")}  ${chalk.cyan("synap proposals approve <id>")}`);
  console.log("");
  console.log(chalk.dim("  Browser navigation (requires desktop app)"));
  console.log(`  ${chalk.cyan("synap open entity <id>")}     ${chalk.dim("→ open entity in side panel")}`);
  console.log(`  ${chalk.cyan("synap open view <id>")}       ${chalk.dim("→ open view in main panel")}`);
  console.log(`  ${chalk.cyan("synap open cell <typeKey>")}  ${chalk.dim("→ open any registered cell in side panel")}`);
  console.log("");
  console.log(chalk.dim("  AI-generated cells (Capability B)"));
  console.log(`  ${chalk.cyan("synap artifact create --html <file>")}  ${chalk.dim("→ define a frame cell from HTML source")}`);
  console.log(`  ${chalk.cyan("  --name <name> --open")}               ${chalk.dim("→ set cell name + open immediately in browser")}`);
  console.log("");
  console.log(chalk.dim("  Context for this session"));
  console.log(`  ${chalk.cyan("synap context")}              ${chalk.dim("→ knowledge + proposals + tasks")}`);
  console.log(`  ${chalk.cyan("synap explain [topic]")}      ${chalk.dim("→ full capability map (this command)")}`);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function explain(opts: ExplainOpts): Promise<void> {
  const topic = opts.topic?.toLowerCase();

  switch (topic) {
    case "graph":
    case "relations":
    case "relation":
      sectionGraph();
      break;
    case "memory":
    case "knowledge":
    case "note":
    case "recall":
      sectionMemory();
      break;
    case "events":
    case "event":
    case "subscribe":
      sectionEvents();
      break;
    case "automation":
    case "automations":
      sectionAutomation();
      break;
    case "views":
    case "view":
    case "bento":
      sectionViews();
      break;
    case "governance":
    case "proposals":
    case "proposal":
      sectionGovernance();
      break;
    case "tools":
    case "connectors":
    case "connector":
    case "integrations":
      sectionConnectors();
      break;
    case "agents":
    case "agent":
      sectionAgents();
      break;
    case "entities":
    case "entity":
    case "profiles":
      sectionEntities();
      break;
    case "quickref":
    case "quick-ref":
    case "ref":
    case "commands":
      sectionQuickRef();
      break;
    case undefined:
    case "":
    case "all": {
      // Full capability map
      console.log(chalk.bold.cyan("\nSynap Capability Map"));
      console.log(chalk.dim("  Sovereign personal data infrastructure. Run any section with: synap explain <topic>"));
      console.log(chalk.dim("  Topics: entities | graph | memory | events | automation | views | governance | connectors | agents\n"));
      sectionEntities();
      sectionGraph();
      sectionMemory();
      sectionEvents();
      sectionAutomation();
      sectionViews();
      sectionGovernance();
      sectionConnectors();
      sectionAgents();
      sectionQuickRef();
      break;
    }
    default:
      console.log(chalk.yellow(`  Unknown topic: "${opts.topic}". Valid topics:`));
      console.log(chalk.dim("  entities | graph | memory | events | automation | views | governance | connectors | agents | commands"));
      process.exit(1);
  }

  console.log("");
}
