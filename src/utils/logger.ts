import chalk from "chalk";

// Diagnostics go to stderr, data goes to stdout. Without this, `synap ask q >
// answer.txt` writes the error INTO answer.txt, `2>/dev/null` can't suppress
// anything, and `--json` consumers get error prose mixed into the payload they
// are trying to parse. Callers that print a failure and its next-action hint
// use error/warn/dim — dim stays on stdout because it is also used for ordinary
// output detail; hint lines that accompany an error are emitted via `hint`.
export const log = {
  info: (msg: string) => console.log(chalk.blue("  " + msg)),
  success: (msg: string) => console.log(chalk.green("  ✓ " + msg)),
  warn: (msg: string) => console.error(chalk.yellow("  ⚠ " + msg)),
  error: (msg: string) => console.error(chalk.red("  ✗ " + msg)),
  /** A next-action line attached to an error — same stream as the error. */
  hint: (msg: string) => console.error(chalk.dim("    " + msg)),
  dim: (msg: string) => console.log(chalk.dim("    " + msg)),
  heading: (msg: string) => console.log("\n" + chalk.bold(msg)),
  blank: () => console.log(""),
};

export function banner() {
  console.log(chalk.cyan(`
  ╔═══════════════════════════════════════╗
  ║         ${chalk.bold("Synap CLI")}                    ║
  ║  Knowledge infrastructure for agents  ║
  ╚═══════════════════════════════════════╝
`));
}

export function scoreColor(score: string): string {
  switch (score) {
    case "A":
      return chalk.green.bold(score);
    case "B":
      return chalk.yellow.bold(score);
    case "C":
      return chalk.hex("#FFA500").bold(score);
    default:
      return chalk.red.bold(score);
  }
}
