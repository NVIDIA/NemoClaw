// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readCredentialByBinding } from "./native-security.mts";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"];
export const NATIVE_SERVICES = {
  brave: { authority: "https://api.search.brave.com", environment: "BRAVE_API_KEY" },
  tavily: { authority: "https://api.tavily.com", environment: "TAVILY_API_KEY" },
  telegram: { authority: "https://api.telegram.org", environment: "TELEGRAM_BOT_TOKEN" },
  discord: { authority: "https://discord.com/api", environment: "DISCORD_BOT_TOKEN" },
  "slack-bot": { authority: "https://slack.com/api", environment: "SLACK_BOT_TOKEN" },
  "slack-app": {
    authority: "https://slack.com/api/apps.connections.open",
    environment: "SLACK_APP_TOKEN",
  },
} as const;
type Service = keyof typeof NATIVE_SERVICES;
type Messaging = { credentialStored: true; allowedUsers: string[]; appCredentialStored?: true };
export type NativeOptions = {
  search?: { provider: "brave" | "tavily"; credentialStored: true };
  messaging?: Partial<Record<"telegram" | "discord" | "slack", Messaging>>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Native setup options contain an unsupported field.");
}

export function normalizeNativeOptions(agent: string, value: unknown): NativeOptions {
  if (!AGENTS.includes(agent) || !record(value))
    throw new Error("Native setup options are invalid.");
  exactKeys(value, ["search", "messaging"]);
  const result: NativeOptions = {};
  if (value.search !== undefined) {
    if (!record(value.search)) throw new Error("Select a supported search provider.");
    exactKeys(value.search, ["provider", "credentialStored"]);
    const { provider, credentialStored } = value.search;
    if (
      credentialStored !== true ||
      !(
        (agent === "openclaw" && (provider === "brave" || provider === "tavily")) ||
        (agent === "hermes" && provider === "tavily")
      )
    )
      throw new Error("This agent does not support the selected search provider.");
    result.search = { provider: provider as "brave" | "tavily", credentialStored: true };
  }
  if (value.messaging !== undefined) {
    if (!record(value.messaging) || !["openclaw", "hermes"].includes(agent))
      throw new Error("Messaging is unavailable for this agent.");
    exactKeys(value.messaging, ["telegram", "discord", "slack"]);
    result.messaging = {};
    for (const channel of ["telegram", "discord", "slack"] as const) {
      const config = value.messaging[channel];
      if (config === undefined) continue;
      if (!record(config)) throw new Error("Messaging configuration is invalid.");
      exactKeys(
        config,
        channel === "slack"
          ? ["credentialStored", "appCredentialStored", "allowedUsers"]
          : ["credentialStored", "allowedUsers"],
      );
      if (
        config.credentialStored !== true ||
        (channel === "slack" && config.appCredentialStored !== true) ||
        !Array.isArray(config.allowedUsers) ||
        config.allowedUsers.length > 50 ||
        !config.allowedUsers.every(
          (id) =>
            typeof id === "string" &&
            (channel === "slack" ? /^[UW][A-Z0-9]{6,31}$/u.test(id) : /^[0-9]{1,24}$/u.test(id)),
        )
      )
        throw new Error("Enter valid messaging user IDs and the required bot keys.");
      result.messaging[channel] = {
        credentialStored: true,
        allowedUsers: [...new Set(config.allowedUsers)] as string[],
        ...(channel === "slack" ? { appCredentialStored: true as const } : {}),
      };
    }
  }
  return result;
}

export function nativeServiceBinding(agent: string, service: string): string {
  if (!AGENTS.includes(agent) || !Object.hasOwn(NATIVE_SERVICES, service))
    throw new Error("The native service credential identity is invalid.");
  // Search and channel keys cannot alias an inference endpoint or another agent.
  return createHash("sha256")
    .update(
      JSON.stringify([
        "nemoclaw-native-service-credential-v1",
        agent,
        service,
        NATIVE_SERVICES[service as Service].authority,
      ]),
    )
    .digest("hex");
}

export function selectedNativeServices(options: NativeOptions): Service[] {
  const services: Service[] = [];
  if (options.search) services.push(options.search.provider);
  for (const channel of ["telegram", "discord", "slack"] as const) {
    if (!options.messaging?.[channel]) continue;
    services.push(...(channel === "slack" ? (["slack-bot", "slack-app"] as const) : [channel]));
  }
  return services;
}

export async function readNativeServiceEnvironment(
  launcher: string,
  agent: string,
  options: unknown,
) {
  const normalized = normalizeNativeOptions(agent, options ?? {});
  const environment: Record<string, string> = {};
  for (const service of selectedNativeServices(normalized)) {
    const key = await readCredentialByBinding(
      launcher,
      service,
      nativeServiceBinding(agent, service),
    );
    if (!key || /[\u0000\r\n]/u.test(key))
      throw new Error(
        "A selected service key is missing or invalid. Open NemoClaw Setup to update it.",
      );
    environment[NATIVE_SERVICES[service].environment] = key;
  }
  return { options: normalized, environment };
}

export function nativeOpenClawOptions(options: NativeOptions) {
  const entries: Record<string, unknown> = {};
  const channels: Record<string, unknown> = {};
  if (options.search) entries[options.search.provider] = { enabled: true };
  for (const channel of ["telegram", "discord", "slack"] as const) {
    const selected = options.messaging?.[channel];
    if (!selected) continue;
    entries[channel] = { enabled: true };
    channels[channel] = {
      enabled: true,
      accounts: {
        default: {
          enabled: true,
          dmPolicy: selected.allowedUsers.length ? "allowlist" : "pairing",
          ...(selected.allowedUsers.length ? { allowFrom: selected.allowedUsers } : {}),
          // Personal network access does not authorize messages from arbitrary senders.
          groupPolicy: "disabled",
        },
      },
    };
  }
  return {
    tools: {
      web: {
        search: options.search
          ? { enabled: true, provider: options.search.provider }
          : { enabled: false },
      },
    },
    plugins: { allow: Object.keys(entries), entries },
    channels,
  };
}

export function nativeHermesConfiguration(
  model: string,
  baseUrl: string,
  brokerToken: string,
  options: NativeOptions,
): string {
  return [
    "model:",
    "  default: " + JSON.stringify(model),
    "  provider: custom",
    "  base_url: " + JSON.stringify(baseUrl),
    "  api_key: " + JSON.stringify(brokerToken),
    "  context_length: 131072",
    ...(options.search
      ? ["web:", "  backend: tavily", "  search_backend: tavily", "  extract_backend: tavily"]
      : ["web:", "  keyless_fallback: false", "agent:", "  disabled_toolsets: [web]"]),
    "platforms:",
    ...Object.entries(options.messaging || {}).flatMap(([channel]) => [
      "  " + channel + ":",
      "    enabled: true",
    ]),
    "memory:",
    "  memory_enabled: true",
    "  user_profile_enabled: true",
    "security:",
    "  allow_lazy_installs: false",
    "updates:",
    "  check: false",
    "  pre_update_backup: false",
    "  refresh_cua_driver: false",
    "",
  ].join("\n");
}

export function createNativeServiceBootstrap(
  selected: { options: NativeOptions; environment: Record<string, string> },
  token: string,
) {
  let delivered = false;
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    if (request.url !== "/native/bootstrap") return false;
    if (
      request.method !== "POST" ||
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers.origin ||
      delivered ||
      request.headers["transfer-encoding"] ||
      (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")
    ) {
      request.resume();
      response.writeHead(403, { "cache-control": "no-store" });
      response.end();
      return true;
    }
    delivered = true;
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(
      JSON.stringify({
        options: selected.options,
        environment: selected.environment,
        openclaw: nativeOpenClawOptions(selected.options),
      }),
    );
    // Only optional service keys cross into the selected agent's environment.
    // The inference provider credential is never part of this object.
    selected.environment = {};
    return true;
  };
}
