// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInferenceConfig } from "../inference/config";
import { MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
import {
  isWebSearchEnabled,
  type WebSearchConfig,
  webSearchProviderForConfig,
} from "../inference/web-search";
import { hydrateDerivedSandboxMessagingPlanFields, MessagingSetupApplier } from "../messaging";
import { parseSandboxMessagingPlan } from "../messaging/plan-validation";
import {
  formatSandboxBaseImageResolutionLabels,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import {
  DEFAULT_TOOL_DISCLOSURE,
  normalizeToolDisclosure,
  type ToolDisclosure,
} from "../tool-disclosure";
import {
  DCODE_AUTO_APPROVAL_BUILD_ARG,
  type DcodeAutoApprovalMode,
  isDcodeAutoApprovalMode,
} from "./dcode-auto-approval";
import {
  dockerfileInstructions,
  readDockerfilePatchSnapshot,
  replaceDockerfilePatchSnapshot,
  validateToolDisclosureDockerfileContract,
} from "./dockerfile-tool-disclosure-contract";

export { assertToolDisclosureDockerfileContract } from "./dockerfile-tool-disclosure-contract";

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

export type DockerfileBuildIdPolicy = "preserve" | "rewrite";

export interface PatchStagedDockerfileOptions {
  buildIdPolicy?: DockerfileBuildIdPolicy;
  toolDisclosure?: ToolDisclosure;
  requireToolDisclosureContract?: boolean;
  baseImageResolutionMetadata?: SandboxBaseImageResolutionMetadata | null;
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
}

export function patchDcodeAutoApprovalDockerArg(
  dockerfile: string,
  mode: DcodeAutoApprovalMode,
): string {
  if (!isDcodeAutoApprovalMode(mode)) {
    throw new Error("Invalid DCode auto-approval mode; refusing to patch the Dockerfile.");
  }
  const instruction = new RegExp(`^ARG ${DCODE_AUTO_APPROVAL_BUILD_ARG}=[^\\r\\n]*$`, "gm");
  const matches = dockerfile.match(instruction) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Dockerfile must contain exactly one ARG ${DCODE_AUTO_APPROVAL_BUILD_ARG}=... instruction; found ${matches.length}.`,
    );
  }
  return dockerfile.replace(instruction, `ARG ${DCODE_AUTO_APPROVAL_BUILD_ARG}=${mode}`);
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
  baseImageRef: string | null = null,
  darwinVmCompat = false,
  inferenceBaseUrlOverride: string | null = null,
  hermesToolGateways: string[] = [],
  options: PatchStagedDockerfileOptions = {},
): void {
  const sanitizedModel = sanitizeDockerArg(model);
  const sandboxInference = getSandboxInferenceConfig(
    sanitizedModel,
    provider,
    preferredInferenceApi,
  );
  const { providerKey, primaryModelRef, inferenceApi, inferenceCompat } = sandboxInference;
  const inferenceBaseUrl =
    inferenceBaseUrlOverride && inferenceBaseUrlOverride.trim()
      ? inferenceBaseUrlOverride
      : sandboxInference.inferenceBaseUrl;
  const patchSnapshot = readDockerfilePatchSnapshot(dockerfilePath);
  let dockerfile = patchSnapshot.content;
  const toolDisclosure = normalizeToolDisclosure(options.toolDisclosure) ?? DEFAULT_TOOL_DISCLOSURE;
  const toolDisclosureInstruction = options.requireToolDisclosureContract
    ? validateToolDisclosureDockerfileContract(dockerfile, toolDisclosure)
    : dockerfileInstructions(dockerfile).find((instruction) =>
        /^ARG\s+NEMOCLAW_TOOL_DISCLOSURE\s*=/.test(instruction.text),
      );
  if (toolDisclosureInstruction) {
    dockerfile = `${dockerfile.slice(0, toolDisclosureInstruction.start)}ARG NEMOCLAW_TOOL_DISCLOSURE=${sanitizeDockerArg(toolDisclosure)}${dockerfile.slice(toolDisclosureInstruction.end)}`;
  }
  if (options.dcodeAutoApprovalMode !== undefined) {
    dockerfile = patchDcodeAutoApprovalDockerArg(dockerfile, options.dcodeAutoApprovalMode);
  }
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
  // Carry the user-selected upstream provider name separately from the
  // managed route key, so Hermes' _nemoclaw_upstream annotation can record
  // the upstream the user actually picked (nvidia-prod, hermes-provider,
  // etc.) rather than the proxy-routing key. The replace is a silent no-op
  // when the staged Dockerfile predates this ARG (e.g. OpenClaw).
  const upstreamProvider = provider && provider.trim() ? provider : providerKey;
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_UPSTREAM_PROVIDER=.*$/m,
    `ARG NEMOCLAW_UPSTREAM_PROVIDER=${sanitizeDockerArg(upstreamProvider)}`,
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
  // Rewriting is the compatibility-safe default for custom and legacy
  // Dockerfiles. Only callers with explicit knowledge of a managed stock
  // Dockerfile may preserve the declaration to keep warm builds cacheable.
  if (options.buildIdPolicy !== "preserve") {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_BUILD_ID=.*$/m,
      `ARG NEMOCLAW_BUILD_ID=${sanitizeDockerArg(buildId)}`,
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DARWIN_VM_COMPAT=.*$/m,
    `ARG NEMOCLAW_DARWIN_VM_COMPAT=${sanitizeDockerArg(darwinVmCompat ? "1" : "0")}`,
  );
  // Honor NEMOCLAW_CONTEXT_WINDOW / NEMOCLAW_MAX_TOKENS / NEMOCLAW_REASONING
  // so the user can tune model metadata without editing the Dockerfile.
  const contextWindow = process.env.NEMOCLAW_CONTEXT_WINDOW;
  // Validate the ceiling as well as the format: POSITIVE_INT_RE alone would let
  // an implausibly large value (which the auto-detect/probe paths reject) bake
  // into the image ARG. Match the auto-detect ceiling. See PR #6293 PRA-4
  // (Nemotron).
  if (
    contextWindow &&
    POSITIVE_INT_RE.test(contextWindow) &&
    Number(contextWindow) <= MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW
  ) {
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
  // shell. Agent Dockerfiles consume these validated build args; dcode pins
  // them into root-owned image files so untrusted runtime env cannot redirect
  // its managed inference traffic. See #1409 and #6191.
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
    `ARG NEMOCLAW_WEB_SEARCH_ENABLED=${sanitizeDockerArg(isWebSearchEnabled(webSearchConfig) ? "1" : "0")}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_WEB_SEARCH_PROVIDER=.*$/m,
    `ARG NEMOCLAW_WEB_SEARCH_PROVIDER=${sanitizeDockerArg(webSearchProviderForConfig(webSearchConfig))}`,
  );
  for (const envKey of [
    "NEMOCLAW_OPENCLAW_OTEL",
    "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT",
    "NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME",
    "NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE",
  ]) {
    const rawValue = process.env[envKey];
    if (rawValue !== undefined && rawValue.trim() !== "") {
      const argPattern = new RegExp(`^ARG ${envKey}=.*$`, "m");
      if (!argPattern.test(dockerfile)) {
        throw new Error(`Dockerfile is missing ARG ${envKey}; cannot apply value ${rawValue}`);
      }
      dockerfile = dockerfile.replace(argPattern, `ARG ${envKey}=${sanitizeDockerArg(rawValue)}`);
    }
  }
  // Onboard flow expects immediate dashboard access without device pairing,
  // so disable device auth for images built during onboard (see #1217).
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DISABLE_DEVICE_AUTH=.*$/m,
    `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=${sanitizeDockerArg("1")}`,
  );
  const messagingPlan = MessagingSetupApplier.readPlanFromEnv();
  if (messagingPlan) {
    const hydratedMessagingPlan = hydrateDerivedSandboxMessagingPlanFields(
      parseSandboxMessagingPlan(messagingPlan) ?? messagingPlan,
    );
    const messagingPlanArgPattern = /^ARG NEMOCLAW_MESSAGING_PLAN_B64=.*$/m;
    if (!messagingPlanArgPattern.test(dockerfile)) {
      throw new Error(
        "Dockerfile is missing ARG NEMOCLAW_MESSAGING_PLAN_B64; cannot apply messaging plan.",
      );
    }
    dockerfile = dockerfile.replace(
      messagingPlanArgPattern,
      `ARG NEMOCLAW_MESSAGING_PLAN_B64=${sanitizeDockerArg(MessagingSetupApplier.encodePlan(hydratedMessagingPlan))}`,
    );
  }
  if (hermesToolGateways.length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=.*$/m,
      "ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
    );
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=.*$/m,
      `ARG NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=${encodeSanitizedDockerJsonArg(hermesToolGateways)}`,
    );
  }

  const baseResolutionLabels = formatSandboxBaseImageResolutionLabels(
    options.baseImageResolutionMetadata,
  );
  if (baseResolutionLabels) {
    dockerfile = `${dockerfile.trimEnd()}\n\n# NemoClaw sandbox-base warm-resolution metadata\n${baseResolutionLabels}\n`;
  }
  // NEMOCLAW_EXTRA_AGENTS_JSON — bake secondary OpenClaw agents into
  // agents.list[] alongside the canonical "main" entry. Pass the raw operator
  // payload through to the build-time validator in
  // scripts/generate-openclaw-config.mts. The host-side encode does not
  // parse or shape-check the JSON: that would duplicate validation logic and
  // could silently drop a malformed payload here while the docs/contract
  // promise an image-build failure. Encoding the raw bytes makes the build
  // the single source of truth for validation errors.
  const extraAgentsRaw = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
  if (extraAgentsRaw && extraAgentsRaw.trim()) {
    const encoded = sanitizeDockerArg(Buffer.from(extraAgentsRaw, "utf8").toString("base64"));
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64=.*$/m,
      `ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64=${encoded}`,
    );
  }
  replaceDockerfilePatchSnapshot(dockerfilePath, patchSnapshot, dockerfile);
}
