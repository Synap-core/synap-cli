/**
 * synap artifact create --html <file>   (RETIRED: an alias of `synap doc create --type html`)
 *
 * An HTML artifact is a document of type html: pod admin runs it at
 * /open/<id> in an isolated frame. This command used to define a Cell from the
 * file (`POST /cells/define`); the Surfaces wave made the HTML artifact ONE
 * body, the html document, so it now makes that document through the same
 * door as `synap doc create` and says so. To define a Cell from source, use
 * `synap cell define`.
 */

import { log } from "../utils/logger.js";
import { docCreate } from "./doc.js";

export interface ArtifactCreateOpts {
  html?: string;
  name?: string;
  workspace?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function artifactCreate(opts: ArtifactCreateOpts): Promise<void> {
  if (!opts.html) {
    log.error("Provide an HTML file path: --html <file>");
    process.exit(1);
  }
  log.warn(
    "`synap artifact create --html` is retired: it is now `synap doc create --type html --file <file>` (an html document)."
  );
  const title =
    opts.name ?? opts.html.split("/").pop()?.replace(/\.html?$/i, "") ?? "artifact";
  await docCreate({
    title,
    file: opts.html,
    type: "html",
    workspace: opts.workspace,
    open: opts.open,
    json: opts.json,
    podUrl: opts.podUrl,
    apiKey: opts.apiKey,
  });
}
