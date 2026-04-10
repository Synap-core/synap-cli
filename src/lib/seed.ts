/**
 * Seed Agent OS entities from OpenClaw config.
 *
 * Auto-detects the OpenClaw agent, installed skills, and model provider,
 * then creates corresponding entities in the Synap pod so the dashboard
 * is pre-populated on first open.
 */

import type { OpenClawInfo } from "./openclaw.js";
import { getConfigValue } from "./openclaw.js";

interface EntityCreate {
  profileSlug: string;
  title: string;
  properties: Record<string, unknown>;
}

/**
 * Detect OpenClaw config and create Agent, Skill, Provider entities.
 * Returns the number of entities created.
 */
export async function seedAgentEntities(
  podUrl: string,
  apiKey: string,
  oc: OpenClawInfo
): Promise<number> {
  const entities: EntityCreate[] = [];

  // 1. Agent entity — the OpenClaw instance itself
  const agentProps: Record<string, unknown> = {
    "agent-status": oc.gatewayRunning ? "Active" : "Idle",
    "agent-runtime": "OpenClaw",
    "agent-deployment": "Local Machine",
  };

  if (oc.version) agentProps["agent-version"] = oc.version;

  // Detect channels from config
  if (oc.config) {
    const channels: string[] = [];
    const channelConfig = getConfigValue(oc.config, "channels") as
      | Record<string, unknown>
      | undefined;
    if (channelConfig) {
      if (channelConfig.telegram) channels.push("Telegram");
      if (channelConfig.discord) channels.push("Discord");
      if (channelConfig.slack) channels.push("Slack");
      if (channelConfig.whatsapp) channels.push("WhatsApp");
      if (channelConfig.email) channels.push("Email");
    }
    // Always has CLI/TUI
    channels.push("CLI");
    agentProps["agent-channels"] = channels;
    if (channels.length > 0) agentProps["agent-channel"] = channels[0];
  }

  // Detect model
  const model = oc.config
    ? (getConfigValue(oc.config, "models.default") as string) ??
      (getConfigValue(oc.config, "models.primary") as string)
    : undefined;
  if (model) agentProps["agent-model"] = model;

  entities.push({
    profileSlug: "agent",
    title: `OpenClaw Agent${oc.version ? ` v${oc.version}` : ""}`,
    properties: agentProps,
  });

  // 2. Skill entities — from installed skills
  if (oc.config) {
    const skills = getConfigValue(oc.config, "skills.installed") as
      | Array<{ name?: string; id?: string }>
      | undefined;
    if (Array.isArray(skills)) {
      for (const skill of skills.slice(0, 10)) {
        // cap at 10
        const name = skill.name ?? skill.id ?? "Unknown Skill";
        entities.push({
          profileSlug: "skill",
          title: name,
          properties: {
            "skill-category": "community",
            "skill-source-url": skill.id
              ? `https://clawhub.io/skills/${skill.id}`
              : undefined,
          },
        });
      }
    }
  }

  // Always add synap skill
  entities.push({
    profileSlug: "skill",
    title: "synap",
    properties: {
      "skill-category": "infrastructure",
      "skill-source-url":
        "https://github.com/synap-core/backend/tree/main/skills/synap",
      "skill-trust": "Verified",
    },
  });

  // 3. Provider entity — model provider
  if (oc.config) {
    const providers = getConfigValue(oc.config, "models.providers") as
      | Record<string, unknown>
      | undefined;
    if (providers) {
      for (const [name, config] of Object.entries(providers).slice(0, 5)) {
        const providerConfig = config as Record<string, unknown>;
        entities.push({
          profileSlug: "provider",
          title: name.charAt(0).toUpperCase() + name.slice(1),
          properties: {
            "provider-type": name,
            "provider-base-url": providerConfig.baseUrl as string | undefined,
            "provider-key-health": providerConfig.apiKey
              ? "Healthy"
              : "Missing",
          },
        });
      }
    }
  }

  // Create entities via Hub Protocol
  let created = 0;
  for (const entity of entities) {
    try {
      const res = await fetch(`${podUrl}/api/hub/entities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          userId: "system",
          agentUserId: "system",
          profileSlug: entity.profileSlug,
          title: entity.title,
          properties: entity.properties,
          reasoning: "Auto-seeded by synap init",
        }),
      });
      if (res.ok) created++;
    } catch {
      // skip failed entities silently
    }
  }

  return created;
}
