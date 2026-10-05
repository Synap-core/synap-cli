/**
 * `synap cell build --self-contained` — the build for an `rendererType:
 * "mcp-app"` cell. A foreign MCP-Apps host (Claude, ChatGPT) loads ONE
 * sandboxed HTML document whose CSP admits no esm.sh, no font origin and no
 * host-supplied React, so the artifact must carry all of it.
 *
 * Fixtures are written to a tmpdir (not `test/fixtures/`): they need a
 * `node_modules/react` the CLI does not depend on, and `*.js` is gitignored
 * here. The stub-React tests always run; the real-React and real-fonts tests
 * resolve the sibling synap-app checkout and are skipped (never vacuously
 * green) when it is absent — the `it.runIf` shape of
 * `frame-import-map-parity.test.ts`.
 *
 * What this does NOT cover: that a host actually renders the document (no
 * browser here), nor that the entry mounts itself — that is the author's job.
 */
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildCellFromSource,
  CellBundleError,
  wrapSelfContainedHtml,
} from "../src/commands/cell.js";
import { resolveCellCodeFiles } from "../src/lib/kind-package.js";

const SYNAP_APP = resolve(process.cwd(), "../synap-app");
const REAL_REACT = join(SYNAP_APP, "node_modules/.pnpm/react@19.2.3/node_modules/react");
const REAL_REACT_DOM = join(
  SYNAP_APP,
  "node_modules/.pnpm/react-dom@19.2.3_react@19.2.3/node_modules/react-dom",
);
const REAL_TOKENS = join(SYNAP_APP, "packages/core/design-tokens");
const hasRealReact = existsSync(REAL_REACT) && existsSync(REAL_REACT_DOM);
const hasRealTokens = existsSync(join(REAL_TOKENS, "src/generated/fonts-css.ts"));

const CSS_MARKER = "synap-probe-card";
const REACT_STUB_MARKER = "__react_stub_marker__";

function write(path: string, content: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A cell project: an entry importing a stylesheet and React. */
function project(opts: { realReact?: boolean; realTokens?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "synap-self-contained-"));
  write(join(dir, "package.json"), JSON.stringify({ name: "probe-cell", private: true }));
  write(
    join(dir, "card.css"),
    // the `content` string survives minification; its `</style>` must not close the element
    `.${CSS_MARKER} { color: rgb(1, 2, 3); }\n.${CSS_MARKER}::after { content: "</style>"; }\n`,
  );
  const nm = join(dir, "node_modules");
  if (opts.realReact) {
    mkdirSync(nm, { recursive: true });
    symlinkSync(REAL_REACT, join(nm, "react"));
    symlinkSync(REAL_REACT_DOM, join(nm, "react-dom"));
    write(
      join(dir, "entry.tsx"),
      `import "./card.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(createElement("div", { className: "${CSS_MARKER}" }, "hi"));
`,
    );
  } else {
    write(join(nm, "react/package.json"), JSON.stringify({ name: "react", main: "index.js" }));
    write(
      join(nm, "react/index.js"),
      `export const MARKER = "${REACT_STUB_MARKER}";\nexport function createElement(t, p) { return { t, p, m: MARKER }; }\n`,
    );
    write(
      join(dir, "entry.tsx"),
      `import "./card.css";
import { createElement } from "react";
export default function Card() { return createElement("div", { className: "${CSS_MARKER}" }); }
`,
    );
  }
  if (opts.realTokens) {
    mkdirSync(join(nm, "@synap-core"), { recursive: true });
    symlinkSync(REAL_TOKENS, join(nm, "@synap-core/design-tokens"));
  }
  return { dir, entry: join(dir, "entry.tsx") };
}

const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
const scriptOf = (html: string) => /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

/** Every way the document could still reach out for code, markup or a stylesheet. */
function externalReferences(html: string): string[] {
  const script = scriptOf(html);
  const markup = html.replace(script, "");
  return [
    ...(html.match(/esm\.sh/g) ?? []),
    ...(markup.match(/<link\b/gi) ?? []),
    // markup only — bundled library code legitimately assigns `el.src = …`
    ...(markup.match(/\bsrc\s*=/gi) ?? []),
    // static `import … from "x"` / `import "x"` / `export … from "x"`, minified or not
    ...(script.match(/(?:\bfrom|\bimport)\s*["'][^"']+["']/g) ?? []),
    // dynamic `import("x")`
    ...(script.match(/\bimport\s*\(\s*["'][^"']+["']\s*\)/g) ?? []),
  ];
}

describe("cell build --self-contained (stub React)", () => {
  it("emits ONE complete HTML document carrying the CSS and the React code", async () => {
    const { entry } = project();
    const built = await buildCellFromSource(entry, { selfContained: true });
    const html = built.code;

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.match(/<html\b/g)).toHaveLength(1);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    // exactly one style element and one module script — the whole artifact
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html.match(/<\/script/gi)).toHaveLength(1);

    expect(styleOf(html)).toContain(CSS_MARKER);
    expect(scriptOf(html)).toContain(REACT_STUB_MARKER);
    // an inlined `</style>` was escaped, so the element is not closed early
    expect(styleOf(html)).toContain("<\\/style>");

    expect(externalReferences(html)).toEqual([]);
    expect(built.deps).toEqual({});
  });

  it("the external-reference scan can see what it hunts (self-check)", () => {
    const sample = `<!doctype html><link rel="stylesheet" href="x"><img src="y"><script type="module">import{a}from"react";import("https://esm.sh/x");</script>`;
    expect(externalReferences(sample).length).toBe(5);
  });

  it("omits the brand faces when design-tokens does not resolve, and --fonts makes that an error", async () => {
    const { entry } = project();
    const html = (await buildCellFromSource(entry, { selfContained: true })).code;
    expect(html).not.toContain("@font-face");
    await expect(
      buildCellFromSource(entry, { selfContained: true, fonts: true }),
    ).rejects.toThrow(/@synap-core\/design-tokens\/fonts does not resolve/);
  });

  it("refuses --deps (nothing resolves via esm.sh in this mode)", async () => {
    const { entry } = project();
    await expect(
      buildCellFromSource(entry, { selfContained: true, deps: '{"x":"1"}' }),
    ).rejects.toBeInstanceOf(CellBundleError);
  });
});

describe("wrapSelfContainedHtml", () => {
  // esbuild already escapes `</style` / `</script` inside the strings it emits
  // (so the end-to-end test above cannot tell whether the wrapper does); this
  // pins the wrapper's own escape for text esbuild did not produce — e.g. the
  // prepended font CSS.
  it("escapes raw closing tags so inlined text cannot end its element early", () => {
    const html = wrapSelfContainedHtml({
      css: 'a::after{content:"</style><b>"}',
      js: 'const s = "</script><b>";',
    });
    expect(html.match(/<\/style/gi)).toHaveLength(1);
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(externalReferences(html)).toEqual([]);
  });
});

describe.runIf(hasRealReact)("cell build --self-contained (real React 19 from synap-app)", () => {
  it("bundles React and react-dom in, production build, no `process` reference", async () => {
    const { entry } = project({ realReact: true });
    const html = (await buildCellFromSource(entry, { selfContained: true })).code;
    const script = scriptOf(html);
    // React 19's element tag — only present if React itself was bundled
    expect(script).toContain("react.transitional.element");
    expect(script.length).toBeGreaterThan(100_000);
    expect(script).not.toMatch(/process\.env/);
    // react-dom carries `</script>`-shaped strings; only the closing tag may remain
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(externalReferences(html)).toEqual([]);
  });
});

describe.runIf(hasRealTokens)("cell build --self-contained (real @synap-core/design-tokens/fonts)", () => {
  it("prepends the inlined brand faces before the cell's own CSS", async () => {
    const { entry } = project({ realTokens: true });
    const html = (await buildCellFromSource(entry, { selfContained: true })).code;
    const style = styleOf(html);
    expect(style).toMatch(/font-family:\s*"Fraunces"/);
    expect(style).toMatch(/font-family:\s*"DM Sans"/);
    expect(style).toContain("data:font/woff2;base64,");
    expect(style).not.toMatch(/googleapis|gstatic/);
    expect(style.indexOf("@font-face")).toBeLessThan(style.indexOf(CSS_MARKER));
    expect(externalReferences(html)).toEqual([]);
  });

  it("fonts:false skips them", async () => {
    const { entry } = project({ realTokens: true });
    const html = (await buildCellFromSource(entry, { selfContained: true, fonts: false })).code;
    expect(html).not.toContain("@font-face");
  });
});

describe("default / --bundle-deps modes refuse an imported stylesheet by name", () => {
  for (const bundleDeps of [false, true]) {
    it(`bundleDeps=${bundleDeps}`, async () => {
      const { entry } = project();
      await expect(buildCellFromSource(entry, { bundleDeps })).rejects.toThrow(
        /imports CSS[^]*card\.css[^]*--self-contained/,
      );
    });
  }
});

describe("market publish: an mcp-app cell's codeFile is built self-contained", () => {
  const pkg = (cell: Record<string, unknown>) => ({
    category: "cell" as const,
    slug: "probe",
    displayName: "Probe",
    definition: { cells: [{ key: "probe", name: "Probe", ...cell }] },
  });

  it("inlines the HTML document as `code`, with deps {} — even with bundleDeps off", async () => {
    const { dir } = project();
    const { definition, errors } = await resolveCellCodeFiles(
      pkg({ codeFile: "entry.tsx", rendererType: "mcp-app" }),
      dir,
      { bundleDeps: false },
    );
    expect(errors).toEqual([]);
    const cell = (definition.cells as Record<string, unknown>[])[0];
    expect(String(cell.code).startsWith("<!doctype html>")).toBe(true);
    expect(styleOf(String(cell.code))).toContain(CSS_MARKER);
    expect(cell.deps).toEqual({});
    expect(cell).not.toHaveProperty("codeFile");
  });

  it("refuses author deps on an mcp-app cell", async () => {
    const { dir } = project();
    const { errors } = await resolveCellCodeFiles(
      pkg({ codeFile: "entry.tsx", rendererType: "mcp-app", deps: { recharts: "2" } }),
      dir,
    );
    expect(errors.join("\n")).toMatch(/mcp-app.*remove "deps"/);
  });

  it("a non-mcp-app cell importing CSS fails the publish loudly", async () => {
    const { dir } = project();
    const { errors } = await resolveCellCodeFiles(pkg({ codeFile: "entry.tsx" }), dir);
    expect(errors.join("\n")).toMatch(/card\.css/);
  });
});
