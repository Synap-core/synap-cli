/**
 * `synap init` exit codes: ONE table, read by init and by its --help text,
 * so a script can tell "no pod" from "cancelled" from "no agent connected".
 */

export const INIT_EXIT = {
  ok: 0,
  usage: 2,
  noPod: 3,
  cancelled: 4,
  noKey: 5,
  noAgent: 6,
} as const;

export type InitExitCode = (typeof INIT_EXIT)[keyof typeof INIT_EXIT];

const MEANING: Record<keyof typeof INIT_EXIT, string> = {
  ok: "at least one agent connected",
  usage: "not a terminal, or a bad flag (pass --pod-url and --agents)",
  noPod: "no pod found, created or reachable",
  cancelled: "cancelled",
  noKey: "could not get your key for the pod (pass --api-key)",
  noAgent: "the pod is ready but no agent was connected",
};

export const INIT_EXIT_HELP =
  "\nExit codes:\n" +
  (Object.keys(INIT_EXIT) as Array<keyof typeof INIT_EXIT>)
    .map((k) => `  ${INIT_EXIT[k]}  ${MEANING[k]}`)
    .join("\n") +
  "\n";

/**
 * A setup step that cannot continue: init prints `message` (unless the step
 * already `shown` it in its own words), puts it in the `--json` summary, and
 * exits with `code`.
 */
export class InitExit extends Error {
  constructor(
    readonly code: InitExitCode,
    message: string,
    readonly shown = false
  ) {
    super(message);
    this.name = "InitExit";
  }
}
