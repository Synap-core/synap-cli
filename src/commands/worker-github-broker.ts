/**
 * Keeps a long run on its GitHub identity.
 *
 * An installation token lasts 1 h; a static GH_TOKEN would stop working under
 * a longer run. So a run's `gh` and `git` ask the WORKER for a token each time
 * they need one, over an owner-only unix socket, and the worker mints or
 * reuses one from the App key (worker-github-app.ts). The key stays in the
 * worker process; a run is handed tokens, never the key, and its environment
 * carries neither the key file's path nor a long-lived secret.
 *
 *   <binDir>/gh                     `gh` with GH_TOKEN set to a fresh token
 *   <binDir>/git-credential-synap   git credential helper (https pushes)
 *   <binDir>/synap-gh-token         asks the broker, prints the token
 *
 * The runs' PATH starts with <binDir>. An absolute /usr/bin/gh still finds no
 * login: the run's GH_CONFIG_DIR is an empty folder (the person's hosts.yml is
 * never read).
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { InstallationTokenSource } from "./worker-github-app.js";

export interface TokenBroker {
  /** The unix socket a run's helpers connect to (SYNAP_GH_SOCK). */
  sock: string;
  ready: Promise<void>;
  close(): void;
}

/** One request = one connection: the answer is `OK <token>\n` or `ERR <message>\n`. */
export function startTokenBroker(source: InstallationTokenSource): TokenBroker {
  // Under the tmp dir, not the state dir: a unix socket path is limited to ~104 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synap-gh-"));
  fs.chmodSync(dir, 0o700);
  const sock = path.join(dir, "s");
  const server = net.createServer((conn) => {
    source.get().then(
      (t) => conn.end(`OK ${t}\n`),
      (err) => conn.end(`ERR ${(err as Error).message.replace(/\s+/g, " ")}\n`)
    );
    conn.on("error", () => conn.destroy());
  });
  server.unref(); // never what keeps the worker process alive
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      fs.chmodSync(sock, 0o600);
      resolve();
    });
  });
  return {
    sock,
    ready,
    close: () => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The first `name` on PATH that is not inside `exclude`. */
export function findOnPath(name: string, searchPath: string | undefined, exclude: string): string | undefined {
  for (const d of (searchPath ?? "").split(path.delimiter)) {
    if (!d || path.resolve(d) === path.resolve(exclude)) continue;
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/**
 * Writes the three helpers. `realGh`: the `gh` to call (undefined: no `gh`
 * wrapper, the box has none). Returns the helper paths.
 */
export function writeGithubHelpers(binDir: string, o: { realGh?: string; nodeBin?: string } = {}): { gitHelper: string } {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const node = o.nodeBin ?? process.execPath;
  const tokenBin = path.join(binDir, "synap-gh-token");
  const put = (name: string, body: string) => fs.writeFileSync(path.join(binDir, name), body, { mode: 0o700 });
  put(
    "synap-gh-token",
    `#!${node}
const net = require("node:net");
const c = net.connect(process.env.SYNAP_GH_SOCK || "");
let buf = "";
c.on("data", (d) => (buf += d));
c.on("error", (e) => { console.error("synap-gh-token: " + e.message); process.exit(1); });
c.on("end", () => {
  const m = /^OK (.+)\\n$/.exec(buf);
  if (!m) { console.error("synap-gh-token: " + (buf.trim() || "no answer")); process.exit(1); }
  process.stdout.write(m[1]);
});
`
  );
  put(
    "git-credential-synap",
    `#!/bin/sh
# git credential helper: only "get" answers; the token is asked for now, never stored.
[ "$1" = get ] || exit 0
cat >/dev/null
t=$(${sh(tokenBin)}) || exit 1
printf 'username=x-access-token\\npassword=%s\\n' "$t"
`
  );
  if (o.realGh) {
    put(
      "gh",
      `#!/bin/sh
t=$(${sh(tokenBin)}) || exit 1
GH_TOKEN="$t" GITHUB_TOKEN="$t" exec ${sh(o.realGh)} "$@"
`
    );
  }
  return { gitHelper: path.join(binDir, "git-credential-synap") };
}
