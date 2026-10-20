#!/usr/bin/env node
/**
 * Generates the CLI reference from the real command tree.
 *
 *   node scripts/gen-cli-reference.mjs           write docs/reference/cli.{json,md}
 *   node scripts/gen-cli-reference.mjs --check   exit 1 if the committed files are stale
 *
 * How it reads the tree: `src/index.ts` builds one commander `program` at module
 * top level and ends with `program.parse()`. This script registers the tsx loader,
 * replaces `Command.prototype.parse` with a function that captures the root
 * command instead of parsing argv, then imports `src/index.ts`. Every name,
 * description, argument and option below is therefore read from the objects
 * commander built — nothing is parsed out of source text, and no command action
 * runs (actions are lazy `await import(...)` calls that only fire on parse).
 *
 * The version string is deliberately left out: it is bumped by the publish
 * workflow and would make the committed reference stale on every release.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import { Command } from "commander";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "reference");
const jsonPath = path.join(outDir, "cli.json");
const mdPath = path.join(outDir, "cli.md");
const check = process.argv.includes("--check");

// ── capture the program ──────────────────────────────────────────────────────

async function loadProgram() {
  let captured;
  const originalParse = Command.prototype.parse;
  Command.prototype.parse = function captureInsteadOfParse() {
    captured = this;
    return this;
  };
  // src/index.ts runs `bootstrapPodOverride(process.argv)` before parse; give it
  // an argv with no user arguments so the capture never depends on how this
  // script was invoked.
  const savedArgv = process.argv;
  process.argv = [savedArgv[0], path.join(root, "src", "index.ts")];
  const unregister = register();
  try {
    await import(pathToFileURL(path.join(root, "src", "index.ts")).href);
  } finally {
    process.argv = savedArgv;
    Command.prototype.parse = originalParse;
    await unregister();
  }
  if (!captured) throw new Error("src/index.ts did not call program.parse(); cannot capture the command tree");
  return captured;
}

// ── serialize ────────────────────────────────────────────────────────────────

function jsonSafe(value) {
  if (value === undefined) return undefined;
  if (typeof value === "function") return "[function]";
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function helpText(cmd, event) {
  let out = "";
  for (const listener of cmd.listeners(event)) {
    listener({ error: false, command: cmd, write: (s) => { out += s; } });
  }
  return out.replace(/^(\s*\n)+/, "").trimEnd() || undefined;
}

function serializeArgument(arg) {
  return prune({
    name: arg.name(),
    description: arg.description || undefined,
    required: arg.required,
    variadic: arg.variadic,
    default: jsonSafe(arg.defaultValue),
    defaultDescription: arg.defaultValueDescription,
    choices: arg.argChoices,
  });
}

function serializeOption(opt) {
  return prune({
    flags: opt.flags,
    long: opt.long,
    short: opt.short,
    description: opt.description || undefined,
    takesValue: opt.required ? "required" : opt.optional ? "optional" : "none",
    variadic: opt.variadic || undefined,
    negate: opt.negate || undefined,
    mandatory: opt.mandatory || undefined,
    default: jsonSafe(opt.defaultValue),
    defaultDescription: opt.defaultValueDescription,
    choices: opt.argChoices,
    env: opt.envVar,
    conflicts: opt.conflictsWith?.length ? opt.conflictsWith : undefined,
    hidden: opt.hidden || undefined,
  });
}

function serializeCommand(cmd, parentPath) {
  const pathParts = parentPath ? [...parentPath, cmd.name()] : [cmd.name()];
  const aliases = cmd.aliases();
  return prune({
    path: pathParts.join(" "),
    name: cmd.name(),
    aliases: aliases.length ? aliases : undefined,
    usage: cmd.usage(),
    summary: cmd.summary() || undefined,
    description: cmd.description() || undefined,
    hidden: Boolean(cmd._hidden),
    arguments: cmd.registeredArguments.map(serializeArgument),
    options: cmd.options.map(serializeOption),
    helpBefore: helpText(cmd, "beforeHelp"),
    helpAfter: helpText(cmd, "afterHelp"),
    subcommands: cmd.commands.map((c) => serializeCommand(c, pathParts)),
  });
}

function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function flatten(cmd, acc = []) {
  acc.push(cmd);
  for (const c of cmd.subcommands) flatten(c, acc);
  return acc;
}

// ── markdown ─────────────────────────────────────────────────────────────────

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function anchor(p) {
  return p.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
}

function renderMarkdown(tree) {
  const all = flatten(tree);
  const listed = [];
  (function walk(c, hiddenAbove) {
    const hidden = hiddenAbove || c.hidden;
    if (!hidden) listed.push(c);
    for (const s of c.subcommands) walk(s, hidden);
  })(tree, false);
  const hiddenCount = all.length - listed.length;

  const lines = [];
  lines.push("<!-- Generated by scripts/gen-cli-reference.mjs from src/index.ts. Do not edit; run `npm run docs:cli`. -->");
  lines.push("");
  lines.push(`# \`${tree.name}\` command reference`);
  lines.push("");
  if (tree.description) lines.push(tree.description, "");
  lines.push(
    `${listed.length - 1} commands. Hidden commands and hidden options are omitted here` +
      (hiddenCount ? ` (${hiddenCount} hidden commands); \`cli.json\` lists them with \`"hidden": true\`.` : "; `cli.json` lists them."),
    "",
  );
  lines.push("Every command also accepts `-h, --help`.", "");

  lines.push("## Commands", "");
  for (const c of listed.slice(1)) {
    const depth = c.path.split(" ").length - 2;
    lines.push(`${"  ".repeat(depth)}- [\`${c.path}\`](#${anchor(c.path)})${c.summary || c.description ? ` — ${cell(firstLine(c.summary || c.description))}` : ""}`);
  }
  lines.push("");

  for (const c of listed) {
    lines.push(`## \`${c.path}\``, "");
    lines.push("```", `${c.path} ${c.usage}`.trimEnd(), "```", "");
    if (c.aliases) lines.push(`Aliases: ${c.aliases.map((a) => `\`${a}\``).join(", ")}`, "");
    if (c.description) lines.push(c.description, "");
    if (c.helpBefore) lines.push("```text", c.helpBefore, "```", "");
    if (c.arguments.length) {
      lines.push("| Argument | Required | Description |", "|---|---|---|");
      for (const a of c.arguments) {
        const extra = [a.variadic ? "variadic" : "", a.default !== undefined ? `default: \`${JSON.stringify(a.default)}\`` : "", a.choices ? `choices: ${a.choices.join(", ")}` : ""].filter(Boolean).join("; ");
        lines.push(`| \`${a.name}\` | ${a.required ? "yes" : "no"} | ${cell(a.description)}${extra ? ` (${extra})` : ""} |`);
      }
      lines.push("");
    }
    const opts = c.options.filter((o) => !o.hidden);
    if (opts.length) {
      lines.push("| Option | Description | Default |", "|---|---|---|");
      for (const o of opts) {
        const def = o.defaultDescription ?? (o.default !== undefined ? JSON.stringify(o.default) : "");
        const extra = [o.mandatory ? "required" : "", o.choices ? `choices: ${o.choices.join(", ")}` : "", o.env ? `env: ${o.env}` : ""].filter(Boolean).join("; ");
        lines.push(`| \`${cell(o.flags)}\` | ${cell(o.description)}${extra ? ` (${extra})` : ""} | ${def ? `\`${cell(def)}\`` : ""} |`);
      }
      lines.push("");
    }
    const subs = c.subcommands.filter((s) => !s.hidden);
    if (subs.length && c !== tree) {
      lines.push("Subcommands: " + subs.map((s) => `[\`${s.name}\`](#${anchor(s.path)})`).join(", "), "");
    }
    if (c.helpAfter) lines.push("```text", c.helpAfter, "```", "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function firstLine(s) {
  return String(s).split(/\r?\n/)[0];
}

// ── main ─────────────────────────────────────────────────────────────────────

const program = await loadProgram();
const tree = serializeCommand(program, null);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const commandCount = flatten(tree).length - 1;
const doc = {
  $comment: "Generated by scripts/gen-cli-reference.mjs from src/index.ts. Do not edit; run `npm run docs:cli`.",
  package: pkg.name,
  binary: Object.keys(pkg.bin ?? {})[0] ?? tree.name,
  commandCount,
  hiddenCommandCount: flatten(tree).filter((c) => c.hidden).length,
  program: tree,
};
const json = JSON.stringify(doc, null, 2) + "\n";
const md = renderMarkdown(tree);

if (check) {
  const stale = [];
  for (const [file, content] of [[jsonPath, json], [mdPath, md]]) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current !== content) stale.push(path.relative(root, file));
  }
  if (stale.length) {
    console.error(`CLI reference is stale: ${stale.join(", ")}`);
    console.error("They no longer match the command tree src/index.ts builds. Run `npm run docs:cli` and commit the result.");
    process.exit(1);
  }
  console.log(`CLI reference is up to date (${commandCount} commands).`);
} else {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonPath, json);
  fs.writeFileSync(mdPath, md);
  console.log(`Wrote ${path.relative(root, jsonPath)} and ${path.relative(root, mdPath)} (${commandCount} commands).`);
}
// src/index.ts registers process-level handlers; do not wait on anything it left open.
process.exit(process.exitCode ?? 0);
