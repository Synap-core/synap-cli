/**
 * A RECIPE as the host runner fills it (plan b647769e §5.2): one named media
 * operation stored as data in a capability's approved manifest
 * (`spec.recipes`), never a shell line.
 *
 * The rule's single definition is `renderRecipe` in
 * `@synap-core/types/capability-manifest/recipe.ts` (backend): "the ONE way a
 * recipe becomes argv". The published types (1.12.13) do not carry it yet, so
 * this file is a port of it as it stands there (plain TypeScript: the CLI has
 * no zod), and test/host-recipe-parity.test.ts renders the same fixtures
 * through both whenever the backend source is checked out beside this repo.
 * The pod checked the recipe's shape when the manifest was approved
 * (`recipeSchema`); the runner checks only what it must to run it safely: an
 * argv of strings, a bare program name, and every value against its type.
 */

export type RecipeParamType = "file" | "files" | "output" | "string" | "number" | "integer" | "enum" | "color" | "time";

export interface RecipeParam {
  type: RecipeParamType;
  description: string;
  required?: boolean;
  default?: string | number;
  options?: string[];
}

export interface Recipe {
  name: string;
  description: string;
  params: Record<string, RecipeParam>;
  steps: Array<{ program: string; args: string[] }>;
  scripts?: Array<{ name: string; sha256: string; source: string }>;
  needs?: { filters?: string[]; encoders?: string[] };
  gotchas: string[];
}

export interface RecipeRunContext {
  /** The run's scratch folder. */
  workdir: string;
  /** Where the runner wrote each script (name → path). */
  scripts?: Record<string, string>;
  /** Pinned programs (`install.<os>.bins`); a program not listed is run by name. */
  bins?: Record<string, string>;
}

export interface RenderedStep {
  program: string;
  args: string[];
}

export const RECIPE_PLACEHOLDER = /\{([^{}]*)\}/g;
/** A value spliced INTO a larger argument (an ffmpeg filter graph) may not carry the graph's syntax. */
const EMBEDDED_UNSAFE = /[\s'":\\;,[\]=]/;
const VALUE_RULES: Partial<Record<RecipeParamType, [RegExp, string]>> = {
  color: [/^(0x|#)?[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, "a hex colour (1A2B3C, 0x1A2B3C or #1A2B3C)"],
  time: [/^(\d+(\.\d+)?|\d{1,2}:\d{2}(:\d{2})?(\.\d+)?)$/, "a time in seconds (12.5) or [hh:]mm:ss"],
};

function valueProblem(param: RecipeParam, value: unknown): string | null {
  switch (param.type) {
    case "files":
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0)
        ? null
        : "a non-empty list of file paths";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "a number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? null : "an integer";
    case "enum":
      return typeof value === "string" && param.options!.includes(value) ? null : `one of ${param.options!.join(", ")}`;
    default: {
      if (typeof value !== "string") return "a string";
      const rule = VALUE_RULES[param.type];
      if (rule && !rule[0].test(value)) return rule[1];
      if ((param.type === "file" || param.type === "output") && value.length === 0) return "a file path";
      return null;
    }
  }
}

/**
 * Fill a recipe with typed values. Throws (naming the param) on a missing or
 * ill-typed value, and on a value that would break the ffmpeg graph it is
 * spliced into. A placeholder that is a whole argument takes any value: an
 * argv is never parsed by a shell.
 */
export function renderRecipe(recipe: Recipe, values: Record<string, unknown>, run: RecipeRunContext): RenderedStep[] {
  const filled: Record<string, string | string[]> = {};
  for (const [name, param] of Object.entries(recipe.params)) {
    const value = values[name] ?? param.default;
    if (value === undefined) throw new Error(`recipe ${recipe.name}: ${name} is required`);
    const bad = valueProblem(param, value);
    if (bad) throw new Error(`recipe ${recipe.name}: ${name} must be ${bad}`);
    filled[name] = Array.isArray(value) ? value.map(String) : String(value);
  }
  for (const name of Object.keys(values)) if (!(name in recipe.params)) throw new Error(`recipe ${recipe.name}: unknown param ${name}`);
  const resolve = (ref: string, whole: boolean): string | string[] => {
    if (ref === "workdir") return run.workdir;
    if (ref.startsWith("bin:")) return run.bins?.[ref.slice("bin:".length)] ?? ref.slice("bin:".length);
    if (ref.startsWith("script:")) {
      const p = run.scripts?.[ref.slice("script:".length)];
      if (!p) throw new Error(`recipe ${recipe.name}: the runner wrote no ${ref.slice("script:".length)}`);
      return p;
    }
    const value = filled[ref]!;
    if (!whole && typeof value === "string" && EMBEDDED_UNSAFE.test(value))
      throw new Error(
        `recipe ${recipe.name}: ${ref} (${JSON.stringify(value)}) is spliced into a filter, so it cannot hold spaces, quotes or : , ; = [ ] \\. Copy the file to a simple name first.`
      );
    return value;
  };
  return recipe.steps.map((step) => ({
    program: run.bins?.[step.program] ?? step.program,
    args: step.args.flatMap((arg) => {
      const whole = /^\{([^{}]*)\}$/.exec(arg);
      if (whole) {
        const v = resolve(whole[1]!, true);
        return Array.isArray(v) ? v : [v];
      }
      return [arg.replace(RECIPE_PLACEHOLDER, (_m, ref: string) => resolve(ref, false) as string)];
    }),
  }));
}

/**
 * The recipe named `name` in an approved manifest (flat computer blocks, or a
 * catalog manifest's `spec`), or why it cannot be run. Only the shape the
 * runner relies on is checked: the pod accepted the rest at approval.
 */
export function findRecipe(manifest: Record<string, unknown>, name: unknown): Recipe | { error: string } {
  const spec = (manifest.spec && typeof manifest.spec === "object" ? manifest.spec : manifest) as Record<string, unknown>;
  const list = Array.isArray(spec.recipes) ? (spec.recipes as unknown[]) : [];
  const raw = list.find((r) => !!r && typeof r === "object" && (r as { name?: unknown }).name === name) as Recipe | undefined;
  if (!raw) return { error: `the approved manifest declares no recipe "${String(name)}"` };
  if (!raw.params || typeof raw.params !== "object") return { error: `recipe ${raw.name}: no params` };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { error: `recipe ${raw.name}: no steps` };
  for (const st of raw.steps) {
    if (typeof st?.program !== "string" || !/^[A-Za-z0-9._-]+$/.test(st.program))
      return { error: `recipe ${raw.name}: a step's program is not a bare name` };
    if (!Array.isArray(st.args) || !st.args.every((a) => typeof a === "string"))
      return { error: `recipe ${raw.name}: a step's args are not an argv of strings` };
  }
  return raw;
}
