/**
 * synap security-audit
 *
 * The single most valuable command. Checks OpenClaw config against
 * 9 known vulnerability patterns and security best practices.
 */

import { log, banner, scoreColor } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { runSecurityChecks, computeScore } from "../lib/hardening.js";
import chalk from "chalk";

interface AuditOptions {
  fix?: boolean;
  json?: boolean;
}

export async function securityAudit(opts: AuditOptions): Promise<void> {
  if (!opts.json) banner();

  // Detect OpenClaw
  const oc = detectOpenClaw();
  if (!oc.found) {
    log.error("OpenClaw not found at ~/.openclaw");
    log.dim("Install OpenClaw first: npm i -g openclaw");
    process.exit(1);
  }

  if (!opts.json) {
    log.heading("Security Audit");
    if (oc.version) log.info(`OpenClaw v${oc.version}`);
    log.blank();
  }

  // Run checks
  const checks = runSecurityChecks(oc.version);

  // JSON output
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          score: computeScore(checks),
          version: oc.version,
          checks: checks.map((c) => ({
            id: c.id,
            name: c.name,
            severity: c.severity,
            passed: c.passed,
            message: c.message,
            fixable: c.fixable,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  // Display results
  const passed = checks.filter((c) => c.passed);
  const failed = checks.filter((c) => !c.passed);

  for (const check of checks) {
    if (check.passed) {
      log.success(check.name);
    } else {
      const sev =
        check.severity === "critical"
          ? chalk.red.bold("CRITICAL")
          : check.severity === "high"
            ? chalk.red("HIGH")
            : check.severity === "medium"
              ? chalk.yellow("MEDIUM")
              : chalk.dim("LOW");
      log.error(`${check.name} [${sev}]`);
      log.dim(check.message);
    }
  }

  // Score
  const score = computeScore(checks);
  log.blank();
  console.log(
    `  Score: ${scoreColor(score)}  (${passed.length}/${checks.length} passed)`
  );

  // Auto-fix
  if (failed.length > 0) {
    const fixable = failed.filter((c) => c.fixable && c.fix);
    if (fixable.length > 0) {
      log.blank();
      if (opts.fix) {
        log.heading("Applying fixes...");
        for (const check of fixable) {
          check.fix!();
          log.success(`Fixed: ${check.name}`);
        }
        log.blank();
        log.info("Re-run audit to verify: synap security-audit");
      } else {
        log.info(
          `${fixable.length} issue(s) can be auto-fixed. Run: synap security-audit --fix`
        );
      }
    }

    const unfixable = failed.filter((c) => !c.fixable);
    if (unfixable.length > 0 && !opts.fix) {
      log.blank();
      log.warn("Manual action required:");
      for (const check of unfixable) {
        log.dim(`  ${check.name}: ${check.message}`);
      }
    }
  } else {
    log.blank();
    log.success("All checks passed. Your OpenClaw deployment is secure.");
  }
}
