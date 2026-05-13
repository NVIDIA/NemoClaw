// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { getSandboxInferenceConfig } from "../inference/config";
import type { WebSearchConfig } from "../inference/web-search";

const SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const PROXY_HOST_RE = /^[A-Za-z0-9._-]+$/;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

type LooseObject = Record<string, unknown>;

export function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8").toString("base64");
}

function sanitizeDockerArg(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]/g, "");
}

function encodeSanitizedDockerJsonArg(value: unknown): string {
  return sanitizeDockerArg(encodeDockerJsonArg(value));
}

export function isValidProxyHost(value: string): boolean {
  return PROXY_HOST_RE.test(value);
}

export function isValidProxyPort(value: string): boolean {
  if (!/^[0-9]{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

export function patchStagedDockerfile(
  dockerfilePath: string,
  model: string,
  chatUiUrl: string,
  buildId = String(Date.now()),
  provider: string | null = null,
  preferredInferenceApi: string | null = null,
  webSearchConfig: WebSearchConfig | null = null,
  messagingChannels: string[] = [],
  messagingAllowedIds: LooseObject = {},
  discordGuilds: LooseObject = {},
  baseImageRef: string | null = null,
  telegramConfig: LooseObject = {},
  darwinVmCompat = false,
): void {
  const sanitizedModel = sanitizeDockerArg(model);
  const { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat } =
    getSandboxInferenceConfig(sanitizedModel, provider, preferredInferenceApi);
  let dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  // Pin the base image to a specific digest when available (#1904).
  // The ref must come from pullAndResolveBaseImageDigest() — never from
  // blueprint.yaml, whose digest belongs to a different registry.
  // Only rewrite when the current value already points at our sandbox-base
  // image — custom --from Dockerfiles may use a different base.
  const sanitizedBaseImageRef = baseImageRef ? sanitizeDockerArg(baseImageRef) : null;
  if (sanitizedBaseImageRef) {
    dockerfile = dockerfile.replace(
      /^ARG BASE_IMAGE=(.*)$/m,
      (line: string, currentValue: string) => {
        const trimmed = String(currentValue).trim();
        if (
          trimmed.startsWith(`${SANDBOX_BASE_IMAGE}:`) ||
          trimmed.startsWith(`${SANDBOX_BASE_IMAGE}@`)
        ) {
          return `ARG BASE_IMAGE=${sanitizedBaseImageRef}`;
        }
        return line;
      },
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_MODEL=.*$/m,
    `ARG NEMOCLAW_MODEL=${sanitizedModel}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PROVIDER_KEY=.*$/m,
    `ARG NEMOCLAW_PROVIDER_KEY=${sanitizeDockerArg(providerKey)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PRIMARY_MODEL_REF=.*$/m,
    `ARG NEMOCLAW_PRIMARY_MODEL_REF=${sanitizeDockerArg(primaryModelRef)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG CHAT_UI_URL=.*$/m,
    `ARG CHAT_UI_URL=${sanitizeDockerArg(chatUiUrl)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_BASE_URL=.*$/m,
    `ARG NEMOCLAW_INFERENCE_BASE_URL=${sanitizeDockerArg(inferenceBaseUrl)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_API=.*$/m,
    `ARG NEMOCLAW_INFERENCE_API=${sanitizeDockerArg(inferenceApi)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_COMPAT_B64=.*$/m,
    `ARG NEMOCLAW_INFERENCE_COMPAT_B64=${encodeSanitizedDockerJsonArg(inferenceCompat)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_BUILD_ID=.*$/m,
    `ARG NEMOCLAW_BUILD_ID=${sanitizeDockerArg(buildId)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DARWIN_VM_COMPAT=.*$/m,
    `ARG NEMOCLAW_DARWIN_VM_COMPAT=${sanitizeDockerArg(darwinVmCompat ? "1" : "0")}`,
  );
  // Honor NEMOCLAW_CONTEXT_WINDOW / NEMOCLAW_MAX_TOKENS / NEMOCLAW_REASONING
  // so the user can tune model metadata without editing the Dockerfile.
  const contextWindow = process.env.NEMOCLAW_CONTEXT_WINDOW;
  if (contextWindow && POSITIVE_INT_RE.test(contextWindow)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_CONTEXT_WINDOW=.*$/m,
      `ARG NEMOCLAW_CONTEXT_WINDOW=${sanitizeDockerArg(contextWindow)}`,
    );
  }
  const maxTokens = process.env.NEMOCLAW_MAX_TOKENS;
  if (maxTokens && POSITIVE_INT_RE.test(maxTokens)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MAX_TOKENS=.*$/m,
      `ARG NEMOCLAW_MAX_TOKENS=${sanitizeDockerArg(maxTokens)}`,
    );
  }
  const reasoning = process.env.NEMOCLAW_REASONING;
  if (reasoning === "true" || reasoning === "false") {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_REASONING=.*$/m,
      `ARG NEMOCLAW_REASONING=${sanitizeDockerArg(reasoning)}`,
    );
  }
  // Honor NEMOCLAW_INFERENCE_INPUTS for vision-capable models. OpenClaw's
  // model schema currently accepts "text" and "image" only, so validate
  // strictly against that vocabulary. Adding modalities to OpenClaw later
  // only requires widening this regex. See #2421.
  const inferenceInputs = process.env.NEMOCLAW_INFERENCE_INPUTS;
  if (inferenceInputs && /^(text|image)(,(text|image))*$/.test(inferenceInputs)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_INFERENCE_INPUTS=.*$/m,
      `ARG NEMOCLAW_INFERENCE_INPUTS=${sanitizeDockerArg(inferenceInputs)}`,
    );
  }
  // NEMOCLAW_AGENT_TIMEOUT — override agents.defaults.timeoutSeconds at build
  // time. Lets users increase the per-request inference timeout without
  // editing the Dockerfile. Ref: issue #2281
  const agentTimeout = process.env.NEMOCLAW_AGENT_TIMEOUT;
  if (agentTimeout && POSITIVE_INT_RE.test(agentTimeout)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_AGENT_TIMEOUT=.*$/m,
      `ARG NEMOCLAW_AGENT_TIMEOUT=${sanitizeDockerArg(agentTimeout)}`,
    );
  }
  // NEMOCLAW_AGENT_HEARTBEAT_EVERY — override agents.defaults.heartbeat.every
  // at build time. Accepts Go-style durations with a required s/m/h suffix
  // ("30m", "1h"); "0m" disables heartbeat. Ref: issue #2880
  const agentHeartbeat = process.env.NEMOCLAW_AGENT_HEARTBEAT_EVERY;
  if (agentHeartbeat && /^\d+(s|m|h)$/.test(agentHeartbeat)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=.*$/m,
      `ARG NEMOCLAW_AGENT_HEARTBEAT_EVERY=${sanitizeDockerArg(agentHeartbeat)}`,
    );
  }
  // Honor NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT exported in the host
  // shell so the sandbox-side nemoclaw-start.sh sees them via $ENV at runtime.
  // Without this, the host export is silently dropped at image build time and
  // the sandbox falls back to the default 10.200.0.1:3128 proxy. See #1409.
  const proxyHostEnv = process.env.NEMOCLAW_PROXY_HOST;
  if (proxyHostEnv && isValidProxyHost(proxyHostEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_HOST=.*$/m,
      `ARG NEMOCLAW_PROXY_HOST=${sanitizeDockerArg(proxyHostEnv)}`,
    );
  }
  const proxyPortEnv = process.env.NEMOCLAW_PROXY_PORT;
  if (proxyPortEnv && isValidProxyPort(proxyPortEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_PORT=.*$/m,
      `ARG NEMOCLAW_PROXY_PORT=${sanitizeDockerArg(proxyPortEnv)}`,
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_WEB_SEARCH_ENABLED=.*$/m,
    `ARG NEMOCLAW_WEB_SEARCH_ENABLED=${sanitizeDockerArg(webSearchConfig ? "1" : "0")}`,
  );
  // Onboard flow expects immediate dashboard access without device pairing,
  // so disable device auth for images built during onboard (see #1217).
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DISABLE_DEVICE_AUTH=.*$/m,
    `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=${sanitizeDockerArg("1")}`,
  );
  if (messagingChannels.length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_CHANNELS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_CHANNELS_B64=${encodeSanitizedDockerJsonArg(messagingChannels)}`,
    );
  }
  if (Object.keys(messagingAllowedIds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${encodeSanitizedDockerJsonArg(messagingAllowedIds)}`,
    );
  }
  if (Object.keys(discordGuilds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_DISCORD_GUILDS_B64=.*$/m,
      `ARG NEMOCLAW_DISCORD_GUILDS_B64=${encodeSanitizedDockerJsonArg(discordGuilds)}`,
    );
  }
  if (telegramConfig && Object.keys(telegramConfig).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_TELEGRAM_CONFIG_B64=.*$/m,
      `ARG NEMOCLAW_TELEGRAM_CONFIG_B64=${encodeSanitizedDockerJsonArg(telegramConfig)}`,
    );
  }
  fs.writeFileSync(dockerfilePath, dockerfile);
}
