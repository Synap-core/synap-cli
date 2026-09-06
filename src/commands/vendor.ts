/**
 * `synap vendor` — the author's PUBLISHER PROFILE.
 * ================================================
 *
 * A package is attributed to a vendor or to nobody. The CP's publish handler is
 * `if (body.vendorId) { … }` with no else: it never auto-creates a vendor, never
 * infers one from the session, and never back-fills attribution afterwards. So
 * an author who publishes before creating a profile is orphaned permanently —
 * their packages can never appear on `GET /api/vendors/:slug`, the page the
 * landing site links as `/superpowers/by/<slug>`.
 *
 * The browser has always had this door (`PublishWizard`'s Publisher step, which
 * blocks until a vendor exists). The CLI only ever READ one. This is the missing
 * half — the same endpoint, the same field names.
 *
 * Transport lives in `lib/cp-packages.ts` (`createVendor` / `fetchMyVendorId`);
 * this file is presentation + exit codes only.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  createVendor,
  fetchMyVendorId,
  CpWriteError,
} from "../lib/cp-packages.js";
import { getCpUrl, getStoredToken } from "../lib/auth.js";

/** `my-studio` → `My Studio` — a default `--name` when the author gives none. */
function titleFromSlug(slug: string): string {
  return (
    slug
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || slug
  );
}

export async function vendorCreate(
  slug: string,
  opts: {
    json?: boolean;
    name?: string;
    description?: string;
    website?: string;
  },
): Promise<void> {
  // Same rule as the CP's `createVendorSchema` — checked here so a typo costs a
  // message rather than a round-trip and a raw zod error.
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(slug)) {
    const message =
      "A publisher slug must be lowercase kebab-case, start with a letter, and be 2–64 characters.";
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: message, slug }, null, 2));
    } else {
      log.error(message);
      log.hint(`e.g. synap vendor create my-studio --name "My Studio"`);
    }
    process.exit(1);
  }

  const displayName = opts.name?.trim() || titleFromSlug(slug);

  try {
    const vendor = await createVendor({
      slug,
      displayName,
      description: opts.description,
      website: opts.website,
    });
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, vendor }, null, 2));
      return;
    }
    log.success(
      `Publisher profile ${chalk.bold(vendor.displayName)} created (@${vendor.slug}).`,
    );
    log.dim("Everything you publish from now on is attributed to it:");
    log.dim(`  ${getCpUrl()}/api/vendors/${vendor.slug}`);
    log.dim("Already published something? Publish it again — the CP attributes");
    log.dim("on write and never back-fills.");
  } catch (e) {
    if (e instanceof CpWriteError) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: false, status: e.status, error: e.serverMessage, slug },
            null,
            2,
          ),
        );
      } else {
        log.error(
          `Could not create the publisher profile${e.status ? ` (HTTP ${e.status})` : ""}: ${e.serverMessage}`,
        );
        // The CP returns 409 for BOTH "you already have one" and "slug taken" —
        // its message distinguishes them, so only add the next action.
        if (e.status === 409) log.hint("Run: synap vendor show");
        if (e.status === 401) log.hint("Run: synap login");
      }
      process.exit(1);
    }
    log.error(`Could not create the publisher profile: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** `synap vendor show` — do I have a publisher profile, and what is published under it? */
export async function vendorShow(opts: { json?: boolean }): Promise<void> {
  const token = getStoredToken()?.token;
  if (!token) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: "not-logged-in" }, null, 2));
    } else {
      log.error("Not logged in.");
      log.hint("Run: synap login");
    }
    process.exit(1);
  }
  const id = await fetchMyVendorId(getCpUrl(), token!);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, vendorId: id }, null, 2));
    return;
  }
  if (!id) {
    // A refusal that names the consequence, not just the absence.
    log.warn("You have no publisher profile.");
    log.hint(
      "Packages you publish will be attributed to nobody, and the CP never back-fills.",
    );
    log.hint(`Create one: synap vendor create <slug> --name "<name>"`);
    return;
  }
  log.success(`You have a publisher profile (id ${id}).`);
}
