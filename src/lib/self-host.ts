/**
 * How a person installs a self-hosted pod — the ONE place the CLI names it.
 *
 * The installer is the `install.sh` asset of the backend's `channel-stable`
 * GitHub release (synap-backend/deploy/README.md "Install"). It needs root on
 * a bare host (it installs Docker and writes /opt/synap), so the command runs
 * it under sudo. It checks the deploy bundle's sha256 against the signed
 * release manifest itself; install.sh has no published checksum of its own,
 * so the command downloads it to a file first, to be read before it runs.
 *
 * Never the synap.live short path (404 on 2026-10-28) and never the raw
 * file on the backend's main branch (an unreleased branch head).
 */

export const SELF_HOST_INSTALL_URL =
  "https://github.com/synap-core/backend/releases/download/channel-stable/install.sh";

export const SELF_HOST_DOCS_URL = "https://github.com/Synap-core/backend/blob/main/deploy/README.md";

/** The shell lines to run on the server, in order. */
export function selfHostInstallCommands(): string[] {
  return [
    `curl -fsSLo synap-install.sh ${SELF_HOST_INSTALL_URL}`,
    "less synap-install.sh   # read it first",
    "sudo bash synap-install.sh --domain <pod.your-domain.com> --email <you@your-domain.com>",
  ];
}
