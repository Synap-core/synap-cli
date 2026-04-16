/**
 * Security hardening checks and fixes for OpenClaw.
 * Based on CVE research and official OpenClaw security docs.
 */

import { chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  readOpenClawConfig,
  writeOpenClawConfig,
  getConfigValue,
  setConfigValue,
  getConfigPermissions,
} from "./openclaw.js";

export interface SecurityCheck {
  id: string;
  name: string;
  severity: "critical" | "high" | "medium" | "low";
  passed: boolean;
  message: string;
  fixable: boolean;
  fix?: () => void;
}

/**
 * Run all 9 security checks against the OpenClaw configuration.
 */
export function runSecurityChecks(version?: string): SecurityCheck[] {
  const config = readOpenClawConfig();
  const checks: SecurityCheck[] = [];

  // 1. Gateway bound to loopback
  const bind = config ? getConfigValue(config, "gateway.bind") : undefined;
  checks.push({
    id: "gateway-bind",
    name: "Gateway bound to loopback",
    severity: "critical",
    passed: !bind || bind === "loopback" || bind === "127.0.0.1",
    message:
      !bind || bind === "loopback" || bind === "127.0.0.1"
        ? "Gateway only accepts local connections"
        : `Gateway bound to "${bind}" — exposed to network`,
    fixable: true,
    fix: config
      ? () => {
          setConfigValue(config, "gateway.bind", "loopback");
          writeOpenClawConfig(config);
        }
      : undefined,
  });

  // 2. Token auth enabled
  const token = config ? getConfigValue(config, "gateway.token") : undefined;
  checks.push({
    id: "gateway-token",
    name: "Token authentication enabled",
    severity: "critical",
    passed: !!token,
    message: token
      ? "Gateway requires token for access"
      : "No gateway token set — anyone can connect",
    fixable: false, // user must set their own token
  });

  // 3. OpenClaw version >= 2026.3.12
  const minVersion = "2026.3.12";
  const versionOk = version ? compareVersions(version, minVersion) >= 0 : true;
  checks.push({
    id: "version",
    name: `OpenClaw version >= ${minVersion}`,
    severity: "critical",
    passed: versionOk,
    message: version
      ? versionOk
        ? `Running v${version}`
        : `Running v${version} — has 9.9 CVSS vulnerability (CVE-2026-24763)`
      : "Could not detect version",
    fixable: false,
  });

  // 4. No plaintext credentials in config
  const hasPlaintext = config
    ? containsPlaintextCredentials(JSON.stringify(config))
    : false;
  checks.push({
    id: "plaintext-creds",
    name: "No plaintext credentials in config",
    severity: "high",
    passed: !hasPlaintext,
    message: hasPlaintext
      ? "Config contains potential plaintext credentials"
      : "No obvious plaintext credentials found",
    fixable: false,
  });

  // 5. File permissions on ~/.openclaw
  const perms = getConfigPermissions();
  const openclawDir = join(homedir(), ".openclaw");
  checks.push({
    id: "file-permissions",
    name: "Config directory permissions",
    severity: "high",
    // If dir doesn't exist (Docker runtime), treat as N/A — not a failure
    passed: perms.mode === "N/A" ? true : perms.safe,
    message:
      perms.mode === "N/A"
        ? "~/.openclaw not present (Docker runtime — config lives in container)"
        : perms.safe
        ? `~/.openclaw mode ${perms.mode} (owner-only)`
        : `~/.openclaw mode ${perms.mode} — readable by others`,
    fixable: perms.mode !== "N/A" && !perms.safe,
    fix:
      perms.mode !== "N/A" && !perms.safe
        ? () => {
            try {
              chmodSync(openclawDir, 0o700);
            } catch {
              // Dir may not exist or may be in Docker — skip silently
            }
          }
        : undefined,
  });

  // 6. WebSocket origin validation
  const wsOrigin = config
    ? getConfigValue(config, "gateway.websocket.validateOrigin")
    : undefined;
  checks.push({
    id: "ws-origin",
    name: "WebSocket origin validation",
    severity: "medium",
    passed: wsOrigin !== false,
    message:
      wsOrigin === false
        ? "WebSocket origin validation disabled"
        : "WebSocket origin validation active",
    fixable: true,
    fix: config
      ? () => {
          setConfigValue(config, "gateway.websocket.validateOrigin", true);
          writeOpenClawConfig(config);
        }
      : undefined,
  });

  // 7. Dangerous skill scanner
  const scanner = config
    ? getConfigValue(config, "skills.dangerousCodeScanner")
    : undefined;
  checks.push({
    id: "skill-scanner",
    name: "Dangerous skill scanner enabled",
    severity: "medium",
    passed: scanner !== false,
    message:
      scanner === false
        ? "Skill scanner disabled — malicious skills can run unchecked"
        : "Skill scanner active",
    fixable: true,
    fix: config
      ? () => {
          setConfigValue(config, "skills.dangerousCodeScanner", true);
          writeOpenClawConfig(config);
        }
      : undefined,
  });

  // 8. Workspace-only filesystem
  const fsAccess = config
    ? getConfigValue(config, "tools.filesystem.scope")
    : undefined;
  checks.push({
    id: "fs-scope",
    name: "Workspace-only filesystem access",
    severity: "medium",
    passed: fsAccess === "workspace" || fsAccess === undefined,
    message:
      fsAccess && fsAccess !== "workspace"
        ? `Filesystem scope: "${fsAccess}" — broader than needed`
        : "Filesystem access scoped to workspace",
    fixable: true,
    fix: config
      ? () => {
          setConfigValue(config, "tools.filesystem.scope", "workspace");
          writeOpenClawConfig(config);
        }
      : undefined,
  });

  // 9. Exec approval gates
  const execApproval = config
    ? getConfigValue(config, "tools.exec.requireApproval")
    : undefined;
  checks.push({
    id: "exec-approval",
    name: "Exec approval gates enabled",
    severity: "low",
    passed: execApproval !== false,
    message:
      execApproval === false
        ? "Shell commands execute without approval"
        : "Exec commands require approval",
    fixable: true,
    fix: config
      ? () => {
          setConfigValue(config, "tools.exec.requireApproval", true);
          writeOpenClawConfig(config);
        }
      : undefined,
  });

  return checks;
}

export function computeScore(checks: SecurityCheck[]): string {
  const criticalFail = checks.some(
    (c) => !c.passed && c.severity === "critical"
  );
  const highFail = checks.some((c) => !c.passed && c.severity === "high");
  const medFail = checks.some((c) => !c.passed && c.severity === "medium");
  const failCount = checks.filter((c) => !c.passed).length;

  if (criticalFail) return "D";
  if (highFail) return "C";
  if (medFail || failCount > 1) return "B";
  return "A";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function containsPlaintextCredentials(text: string): boolean {
  const patterns = [
    /sk-[a-zA-Z0-9]{20,}/,
    /sk_live_[a-zA-Z0-9]{20,}/,
    /password["']\s*:\s*["'][^"']+["']/i,
  ];
  return patterns.some((p) => p.test(text));
}
