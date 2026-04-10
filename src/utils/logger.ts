import chalk from "chalk";

export const log = {
  info: (msg: string) => console.log(chalk.blue("  " + msg)),
  success: (msg: string) => console.log(chalk.green("  ✓ " + msg)),
  warn: (msg: string) => console.log(chalk.yellow("  ⚠ " + msg)),
  error: (msg: string) => console.log(chalk.red("  ✗ " + msg)),
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
