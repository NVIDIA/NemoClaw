// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInferenceConfig, isSafeModelId } from "../inference/config";
import { MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
import {
  isWebSearchEnabled,
  type WebSearchConfig,
  webSearchProviderForConfig,
} from "../inference/web-search";
import {
  hydrateDerivedSandboxMessagingPlanFields,
  MessagingSetupApplier,
  type SandboxMessagingPlan,
} from "../messaging";
import { parseSandboxMessagingPlan } from "../messaging/plan-validation";
import {
  formatSandboxBaseImageResolutionLabels,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import {
  mergeHermesPreservedEnvIntoMessagingPlan,
  type PreservedEnvFile,
} from "../state/preserved-env/index";
import {
  DEFAULT_TOOL_DISCLOSURE,
  normalizeToolDisclosure,
  type ToolDisclosure,
} from "../tool-disclosure";
import {
  CORPORATE_CA_EXPLICIT_ENV,
  encodeCorporateCaArg,
  resolveCorporateCa,
} from "./corporate-ca";
import { warnCorporateCa } from "./corporate-ca-policy";
import {
  DCODE_AUTO_APPROVAL_BUILD_ARG,
  type DcodeAutoApprovalMode,
  isDcodeAutoApprovalMode,
} from "./dcode-auto-approval";
import { isValidDcodeUpstreamProvider } from "./managed-startup/dcode-upstream-provider";
import * as remoteDashboardBindContract from "./dockerfile-remote-dashboard-bind-contract";
import {
  type DockerfileInstruction,
  dockerfileInstructions,
  readDockerfilePatchSnapshot,
  replaceDockerfilePatchSnapshot,
  validateToolDisclosureDockerfileContract,
} from "./dockerfile-tool-disclosure-contract";
import { normalizeReasoningEffort, REASONING_EFFORT_ENV } from "./reasoning-mode";

export { assertToolDisclosureDockerfileContract } from "./dockerfile-tool-disclosure-contract";

const SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const NODE_RUNTIME_REFRESH_INSTRUCTION =
  "COPY --from=builder /usr/local/bin/node /usr/local/bin/node";
const PROXY_HOST_RE = /^[A-Za-z0-9._-]+$/;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

type LooseObject = Record<string, unknown>;

export function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8").toString("base64");
}

function sanitizeDockerArg(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]/g, "");
}

export interface HermesPortableDockerfileBuildSettings {
  readonly model: string;
  readonly provider: string | null;
  readonly preferredInferenceApi: string | null;
  readonly toolDisclosure: ToolDisclosure;
}

function replaceExactHermesPortableDockerArg(source: string, name: string, value: string): string {
  const sanitized = sanitizeDockerArg(value);
  if (sanitized !== value || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`Hermes portable ${name} build setting is invalid.`);
  }
  const pattern = new RegExp(`^ARG ${name}=.*$`, "gmu");
  if ((source.match(pattern) ?? []).length !== 1) {
    throw new Error(`Hermes Dockerfile must declare exactly one ${name} build argument.`);
  }
  return source.replace(pattern, `ARG ${name}=${sanitized}`);
}

function pinHermesPortableTargetArchitecture(source: string): string {
  const firstStage = source.search(/^FROM\s/gmu);
  if (firstStage < 0) {
    throw new Error("Hermes Dockerfile must declare at least one build stage.");
  }
  const globalArguments = source.slice(0, firstStage);
  const targetArchitecture = /^ARG TARGETARCH$/gmu;
  if ((globalArguments.match(targetArchitecture) ?? []).length !== 1) {
    throw new Error("Hermes Dockerfile must declare one unpinned global TARGETARCH argument.");
  }
  return `${globalArguments.replace(targetArchitecture, "ARG TARGETARCH=amd64")}${source.slice(firstStage)}`;
}

/** Render the reviewed non-secret schema-5 Hermes image settings from the shared route owner. */
export function renderHermesPortableDockerfileBuildSettings(
  source: string,
  input: HermesPortableDockerfileBuildSettings,
): string {
  if (!input.model || input.model.length > 4096 || !isSafeModelId(input.model)) {
    throw new Error("Hermes portable model build setting is invalid.");
  }
  if (input.provider !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.provider)) {
    throw new Error("Hermes portable provider build setting is invalid.");
  }
  if (
    input.preferredInferenceApi !== null &&
    !["anthropic-messages", "openai-completions", "openai-responses"].includes(
      input.preferredInferenceApi,
    )
  ) {
    throw new Error("Hermes portable inference API build setting is invalid.");
  }
  const toolDisclosure = normalizeToolDisclosure(input.toolDisclosure);
  if (toolDisclosure !== input.toolDisclosure) {
    throw new Error("Hermes portable tool disclosure build setting is invalid.");
  }
  const inference = getSandboxInferenceConfig(
    input.model,
    input.provider,
    input.preferredInferenceApi,
  );
  const replacements = [
    ["NEMOCLAW_MODEL", input.model],
    ["NEMOCLAW_INFERENCE_PROVIDER_ID", inference.providerKey],
    ["NEMOCLAW_UPSTREAM_PROVIDER", input.provider ?? inference.providerKey],
    ["NEMOCLAW_INFERENCE_BASE_URL", inference.inferenceBaseUrl],
    ["NEMOCLAW_INFERENCE_API", inference.inferenceApi],
    ["NEMOCLAW_TOOL_DISCLOSURE", toolDisclosure],
    ["CHAT_UI_URL", ""],
  ] as const;
  return replacements.reduce(
    (rendered, [name, value]) => replaceExactHermesPortableDockerArg(rendered, name, value),
    pinHermesPortableTargetArchitecture(source),
  );
}

function encodeSanitizedDockerJsonArg(value: unknown): string {
  return sanitizeDockerArg(encodeDockerJsonArg(value));
}

function normalizeOptionalEndpointUrlArg(value: string | null | undefined, name: string): string {
  if (value === null || value === undefined || value.trim() === "") return "";
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not include query strings or fragments.`);
  }
  return url.href;
}

export type DockerfileBuildIdPolicy = "preserve" | "rewrite";

export interface PatchStagedDockerfileOptions {
  agentName?: string;
  buildIdPolicy?: DockerfileBuildIdPolicy;
  toolDisclosure?: ToolDisclosure;
  requireToolDisclosureContract?: boolean;
  trustedManagedDockerfile?: boolean;
  baseImageResolutionMetadata?: SandboxBaseImageResolutionMetadata | null;
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  upstreamEndpointUrl?: string | null;
  compatibleEndpointReasoning?: "true" | "false";
  wslDashboardExposure?: boolean;
  rebuildPreservedEnv?: readonly PreservedEnvFile[];
}

function openClawRootStartupArg(dockerfile: string): DockerfileInstruction | null {
  const instructions = dockerfileInstructions(dockerfile);
  const finalFromIndex = instructions.reduce(
    (last, instruction, index) => (/^FROM(?:\s|$)/i.test(instruction.text) ? index : last),
    -1,
  );
  const finalStage = instructions.slice(finalFromIndex + 1);
  const runtimeUserArgs = finalStage.filter((instruction) => {
    const match = /^(\S+)\s+NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER\s*=/.exec(instruction.text);
    return match?.[1]?.toUpperCase() === "ARG";
  });
  if (runtimeUserArgs.length !== 1) return null;

  const runtimeUserArg = runtimeUserArgs[0]!;
  const runtimeUserArgIndex = finalStage.indexOf(runtimeUserArg);
  const finalUserIndex = finalStage.reduce(
    (last, instruction, index) => (/^USER(?:\s|$)/i.test(instruction.text) ? index : last),
    -1,
  );
  const finalEntrypointIndex = finalStage.reduce(
    (last, instruction, index) => (/^ENTRYPOINT(?:\s|$)/i.test(instruction.text) ? index : last),
    -1,
  );
  const finalUser = finalStage[finalUserIndex]?.text ?? "";
  const finalUserMatch = /^USER\s+(.+)$/i.exec(finalUser);
  const finalEntrypoint = finalStage[finalEntrypointIndex]?.text ?? "";
  const finalEntrypointMatch = /^ENTRYPOINT\s+(.+)$/i.exec(finalEntrypoint);
  let trustedEntrypoint = false;
  try {
    const entrypoint = JSON.parse(finalEntrypointMatch?.[1] ?? "");
    trustedEntrypoint =
      Array.isArray(entrypoint) &&
      entrypoint.length === 1 &&
      entrypoint[0] === "/usr/local/bin/nemoclaw-start";
  } catch {
    // Root startup requires the trusted exec-form entrypoint.
  }
  const runtimeUserControlsStartup =
    runtimeUserArgIndex < finalUserIndex &&
    finalUserIndex < finalEntrypointIndex &&
    finalUserMatch?.[1] === "${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER}" &&
    trustedEntrypoint;
  return runtimeUserControlsStartup ? runtimeUserArg : null;
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

export type PatchedDockerfileMetadata = { dashboardRemoteBindPrepared: boolean };

export { hasPreparedRemoteDashboardBind } from "./dockerfile-remote-dashboard-bind-contract";

function patchMessagingPlanDockerArg(
  dockerfile: string,
  plan: SandboxMessagingPlan,
  preservedEnv: readonly PreservedEnvFile[] | undefined,
): string {
  const baseMessagingPlan = hydrateDerivedSandboxMessagingPlanFields(
    parseSandboxMessagingPlan(plan) ?? plan,
  );
  const imageMessagingPlan = mergeHermesPreservedEnvIntoMessagingPlan(
    baseMessagingPlan,
    preservedEnv,
  );
  const messagingPlanArgPattern = /^ARG NEMOCLAW_MESSAGING_PLAN_B64=.*$/m;
  if (!messagingPlanArgPattern.test(dockerfile)) {
    throw new Error(
      "Dockerfile is missing ARG NEMOCLAW_MESSAGING_PLAN_B64; cannot apply messaging plan.",
    );
  }
  return dockerfile.replace(
    messagingPlanArgPattern,
    `ARG NEMOCLAW_MESSAGING_PLAN_B64=${sanitizeDockerArg(MessagingSetupApplier.encodePlanForImageBuild(imageMessagingPlan))}`,
  );
}

export function patchStagedDockerfileMessagingPlan(
  dockerfilePath: string,
  plan: SandboxMessagingPlan,
  preservedEnv: readonly PreservedEnvFile[],
): void {
  const patchSnapshot = readDockerfilePatchSnapshot(dockerfilePath);
  const dockerfile = patchMessagingPlanDockerArg(patchSnapshot.content, plan, preservedEnv);
  replaceDockerfilePatchSnapshot(dockerfilePath, patchSnapshot, dockerfile);
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
): PatchedDockerfileMetadata {
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
  // A source=local resolution is built from this checkout's Dockerfile.base,
  // whose Node image pin is kept identical to the managed Dockerfile builder.
  // Copying that same 125 MB binary into the final image creates a redundant
  // export layer. Keep the checked-in COPY as the safe default for published
  // and legacy bases, and elide it only for this trusted, authoritative local
  // base path. Custom Dockerfiles never receive trusted resolution metadata.
  if (
    options.trustedManagedDockerfile === true &&
    options.baseImageResolutionMetadata?.imageName === SANDBOX_BASE_IMAGE &&
    options.baseImageResolutionMetadata.source === "local" &&
    sanitizedBaseImageRef === options.baseImageResolutionMetadata.ref
  ) {
    const instructionCount = dockerfile
      .split(/\r?\n/)
      .filter((line) => line.trim() === NODE_RUNTIME_REFRESH_INSTRUCTION).length;
    if (instructionCount !== 1) {
      throw new Error(
        `Managed OpenClaw Dockerfile must contain exactly one ${NODE_RUNTIME_REFRESH_INSTRUCTION} instruction; found ${instructionCount}.`,
      );
    }
    dockerfile = dockerfile.replace(
      NODE_RUNTIME_REFRESH_INSTRUCTION,
      "# Node runtime refresh omitted: authoritative local base already uses the builder pin.",
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_MODEL=.*$/m,
    `ARG NEMOCLAW_MODEL=${sanitizedModel}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_PROVIDER_ID=.*$/m,
    `ARG NEMOCLAW_INFERENCE_PROVIDER_ID=${sanitizeDockerArg(providerKey)}`,
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
  if (
    options.agentName === "langchain-deepagents-code" &&
    !isValidDcodeUpstreamProvider(upstreamProvider)
  ) {
    throw new Error(
      "NEMOCLAW_UPSTREAM_PROVIDER must start with an ASCII letter or digit and contain 1-64 ASCII letters, digits, dots, underscores, or hyphens for DCode.",
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_UPSTREAM_PROVIDER=.*$/m,
    `ARG NEMOCLAW_UPSTREAM_PROVIDER=${sanitizeDockerArg(upstreamProvider)}`,
  );
  const upstreamEndpointUrl = normalizeOptionalEndpointUrlArg(
    options.upstreamEndpointUrl,
    "NEMOCLAW_UPSTREAM_ENDPOINT_URL",
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_UPSTREAM_ENDPOINT_URL=.*$/m,
    `ARG NEMOCLAW_UPSTREAM_ENDPOINT_URL=${upstreamEndpointUrl}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PRIMARY_MODEL_REF=.*$/m,
    `ARG NEMOCLAW_PRIMARY_MODEL_REF=${sanitizeDockerArg(primaryModelRef)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG CHAT_UI_URL=.*$/m,
    `ARG CHAT_UI_URL=${sanitizeDockerArg(chatUiUrl)}`,
  );
  if (options.wslDashboardExposure !== undefined) {
    const wslDashboardExposureArg = /^ARG NEMOCLAW_WSL_DASHBOARD_EXPOSURE=.*$/m;
    const hasWslDashboardExposureArg = wslDashboardExposureArg.test(dockerfile);
    if (options.wslDashboardExposure && !hasWslDashboardExposureArg) {
      throw new Error(
        "Dockerfile is missing ARG NEMOCLAW_WSL_DASHBOARD_EXPOSURE; cannot record WSL dashboard exposure.",
      );
    }
    if (hasWslDashboardExposureArg) {
      dockerfile = dockerfile.replace(
        wslDashboardExposureArg,
        `ARG NEMOCLAW_WSL_DASHBOARD_EXPOSURE=${options.wslDashboardExposure ? "1" : "0"}`,
      );
    }
  }
  const remoteDashboardBind = remoteDashboardBindContract.patchRequestedRemoteDashboardBindContract(
    dockerfile,
    process.env.NEMOCLAW_DASHBOARD_BIND,
    options.trustedManagedDockerfile === true,
  );
  dockerfile = remoteDashboardBind.dockerfile;
  const { dashboardRemoteBindPrepared } = remoteDashboardBind;
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
  const reasoning = options.compatibleEndpointReasoning ?? process.env.NEMOCLAW_REASONING;
  if (reasoning === "true" || reasoning === "false") {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_REASONING=.*$/m,
      `ARG NEMOCLAW_REASONING=${sanitizeDockerArg(reasoning)}`,
    );
  }
  const reasoningEffort = normalizeReasoningEffort(process.env[REASONING_EFFORT_ENV]);
  if (reasoningEffort) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_REASONING_EFFORT=.*$/m,
      `ARG NEMOCLAW_REASONING_EFFORT=${sanitizeDockerArg(reasoningEffort)}`,
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
  // NEMOCLAW_AGENT_TIMEOUT overrides the agent-run and provider-request timeouts
  // at build time. Users can increase the inference timeout without
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
  // These four ARGs configure OpenClaw's own diagnostics exporter and are
  // declared only by the OpenClaw Dockerfile. Another agent's staged Dockerfile
  // is not missing them, so report the agent mismatch the way the managed
  // startup path already does instead of an internal Dockerfile-authoring error.
  const otelAgentName = options.agentName ?? "openclaw";
  for (const envKey of [
    "NEMOCLAW_OPENCLAW_OTEL",
    "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT",
    "NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME",
    "NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE",
  ]) {
    const rawValue = process.env[envKey];
    if (rawValue === undefined || rawValue.trim() === "") continue;
    const argPattern = new RegExp(`^ARG ${envKey}=.*$`, "m");
    if (!argPattern.test(dockerfile)) {
      throw new Error(
        otelAgentName === "openclaw"
          ? `Dockerfile is missing ARG ${envKey}; cannot apply value ${rawValue}`
          : `${envKey} is not supported by ${otelAgentName}`,
      );
    }
    dockerfile = dockerfile.replace(argPattern, `ARG ${envKey}=${sanitizeDockerArg(rawValue)}`);
  }
  // Keep the managed pairing opt-out distinct from an operator's choice.
  dockerfile = remoteDashboardBindContract.patchManagedDeviceAuthOptOutContract(dockerfile);
  const messagingPlan = MessagingSetupApplier.readPlanFromEnv();
  if (messagingPlan) {
    dockerfile = patchMessagingPlanDockerArg(
      dockerfile,
      messagingPlan,
      options.rebuildPreservedEnv,
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
  // Corporate proxy CA import (#6210). When the host exposes an operator
  // corporate CA bundle — via env var or an installed host trust-store anchor —
  // bake its base64 so the entrypoint can append it to the OpenShell trust
  // bundle at runtime (never replacing it). The replace is a silent no-op on
  // custom/legacy Dockerfiles that predate this ARG.
  const corporateCa = resolveCorporateCa(process.env);
  if (corporateCa) {
    if (options.agentName === undefined) {
      throw new Error(
        "NemoClaw cannot bake a corporate CA without the staged Dockerfile agent identity.",
      );
    }
    const corporateCaArgPattern = /^ARG NEMOCLAW_CORPORATE_CA_B64=.*$/m;
    const openClawRootStartup = options.agentName === "openclaw";
    const runtimeUserArg = openClawRootStartup ? openClawRootStartupArg(dockerfile) : null;
    if (
      corporateCaArgPattern.test(dockerfile) &&
      (!openClawRootStartup || runtimeUserArg !== null)
    ) {
      if (runtimeUserArg) {
        // Root startup creates the merged runtime trust bundle before the
        // entrypoint starts the sandbox user's agent process (#8803).
        dockerfile = `${dockerfile.slice(0, runtimeUserArg.start)}ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root${dockerfile.slice(runtimeUserArg.end)}`;
      }
      dockerfile = dockerfile.replace(
        corporateCaArgPattern,
        `ARG NEMOCLAW_CORPORATE_CA_B64=${sanitizeDockerArg(encodeCorporateCaArg(corporateCa.pem))}`,
      );
      // Surface which host source is being baked so a fallback import (from a
      // conventional CA env var rather than the explicit opt-in) is never
      // silent. The CA is a public certificate, so logging its source is safe.
      console.error(
        `[nemoclaw] baking corporate proxy CA from ${corporateCa.sourceEnv} (${corporateCa.sourcePath}) into the sandbox image trust (#6210)`,
      );
    } else if (corporateCa.sourceEnv === CORPORATE_CA_EXPLICIT_ENV) {
      // Explicit opt-in must not silently no-op on a managed Dockerfile.
      if (!corporateCaArgPattern.test(dockerfile)) {
        throw new Error(
          "Dockerfile is missing ARG NEMOCLAW_CORPORATE_CA_B64; cannot bake the corporate CA from NEMOCLAW_CORPORATE_CA_BUNDLE.",
        );
      }
      throw new Error(
        "Custom OpenClaw Dockerfile must declare exactly one final-stage ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER. " +
          "It must set USER ${NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER} before " +
          'ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]. ' +
          "NemoClaw cannot bake the corporate CA from NEMOCLAW_CORPORATE_CA_BUNDLE.",
      );
    } else {
      // A fallback source stays a no-op when a custom Dockerfile lacks either
      // build argument required for root-owned runtime trust. Onboarding still
      // exits 0 and the sandbox still reaches Ready, so report the dropped
      // anchor here; otherwise the missing trust is invisible until external
      // TLS through the corporate proxy fails at runtime (#8454).
      const reason = corporateCaArgPattern.test(dockerfile)
        ? "the Dockerfile does not declare a final-stage ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER that controls the image user before the NemoClaw entrypoint"
        : "the Dockerfile is missing ARG NEMOCLAW_CORPORATE_CA_B64";
      warnCorporateCa(
        `corporate proxy CA from ${corporateCa.sourceEnv} (${corporateCa.sourcePath}) was not baked ` +
          `into the sandbox image because ${reason}; the sandbox will start without a corporate ` +
          "trust anchor and external TLS through the corporate proxy may fail",
      );
    }
  }

  replaceDockerfilePatchSnapshot(dockerfilePath, patchSnapshot, dockerfile);
  return { dashboardRemoteBindPrepared };
}
