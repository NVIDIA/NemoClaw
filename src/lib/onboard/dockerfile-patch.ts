// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { getSandboxInferenceConfig } from "../inference/config";
import type { WebSearchConfig } from "../inference/web-search";
import { hydrateDerivedSandboxMessagingPlanFields, MessagingSetupApplier } from "../messaging";
import { parseSandboxMessagingPlan } from "../messaging/plan-validation";
import {
  DEFAULT_TOOL_DISCLOSURE,
  normalizeToolDisclosure,
  type ToolDisclosure,
} from "../tool-disclosure";

const SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const PROXY_HOST_RE = /^[A-Za-z0-9._-]+$/;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

type LooseObject = Record<string, unknown>;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW;

function errnoCode(err: unknown): string | null {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function openExistingRegularDockerfileNoFollow(dockerfilePath: string, flags: number): number {
  if (typeof O_NOFOLLOW !== "number") {
    throw new Error("Refusing to patch Dockerfile: O_NOFOLLOW is unavailable on this platform.");
  }
  let fd: number;
  try {
    fd = fs.openSync(dockerfilePath, flags | O_NOFOLLOW, 0o600);
  } catch (err) {
    if (errnoCode(err) === "ELOOP") {
      throw new Error(`Refusing to patch Dockerfile through a symlink: ${dockerfilePath}`);
    }
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Refusing to patch non-regular Dockerfile path: ${dockerfilePath}`);
    }
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function readExistingDockerfileNoFollow(dockerfilePath: string): string {
  const fd = openExistingRegularDockerfileNoFollow(dockerfilePath, fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function writeExistingDockerfileNoFollow(dockerfilePath: string, dockerfile: string): void {
  const fd = openExistingRegularDockerfileNoFollow(dockerfilePath, fs.constants.O_WRONLY);
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, dockerfile, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
}

interface DockerfileInstruction {
  text: string;
  start: number;
  end: number;
}

interface DockerfileHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

function decodeDockerfileHeredocWord(raw: string): string | null {
  let decoded = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < raw.length) {
        index += 1;
        decoded += raw[index]!;
      } else decoded += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\\" && index + 1 < raw.length) {
      index += 1;
      decoded += raw[index]!;
    } else {
      decoded += char;
    }
  }
  return quote === null && decoded ? decoded : null;
}

function dockerfileHeredocs(instruction: string): DockerfileHeredoc[] {
  if (!/^(?:RUN|COPY)\s/i.test(instruction)) return [];
  const heredocs: DockerfileHeredoc[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < instruction.length; index += 1) {
    const char = instruction[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (
      char !== "<" ||
      instruction[index - 1] === "<" ||
      instruction[index + 1] !== "<" ||
      instruction[index + 2] === "<"
    ) {
      continue;
    }

    let wordStart = index + 2;
    const stripTabs = instruction[wordStart] === "-";
    if (stripTabs) wordStart += 1;
    let wordEnd = wordStart;
    let wordQuote: "'" | '"' | null = null;
    for (; wordEnd < instruction.length; wordEnd += 1) {
      const wordChar = instruction[wordEnd]!;
      if (wordQuote) {
        if (wordChar === wordQuote) wordQuote = null;
        else if (wordChar === "\\" && wordQuote === '"') wordEnd += 1;
        continue;
      }
      if (wordChar === "'" || wordChar === '"') {
        wordQuote = wordChar;
        continue;
      }
      if (wordChar === "\\") {
        wordEnd += 1;
        continue;
      }
      if (/\s|[;&|()<>]/.test(wordChar)) break;
    }
    const rawWord = instruction.slice(wordStart, wordEnd);
    const delimiter = wordQuote === null ? decodeDockerfileHeredocWord(rawWord) : null;
    if (!delimiter) {
      throw new Error("Custom Dockerfile contains an invalid heredoc delimiter.");
    }
    heredocs.push({ delimiter, stripTabs });
    index = wordEnd - 1;
  }
  return heredocs;
}

interface DockerfileWord {
  decoded: string;
  raw: string;
}

function tokenizeDockerfileWords(input: string): DockerfileWord[] | null {
  const words: DockerfileWord[] = [];
  let decoded = "";
  let wordStart = -1;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < input.length) {
        index += 1;
        decoded += input[index]!;
      } else decoded += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      if (wordStart < 0) wordStart = index;
    } else if (char === "\\" && index + 1 < input.length) {
      if (wordStart < 0) wordStart = index;
      index += 1;
      decoded += input[index]!;
    } else if (/\s/.test(char)) {
      if (wordStart >= 0) {
        words.push({ decoded, raw: input.slice(wordStart, index) });
        decoded = "";
        wordStart = -1;
      }
    } else {
      if (wordStart < 0) wordStart = index;
      decoded += char;
    }
  }
  if (quote) return null;
  if (wordStart >= 0) words.push({ decoded, raw: input.slice(wordStart) });
  return words;
}

function dockerfileEnvValue(instruction: string, key: string): DockerfileWord | undefined {
  const envMatch = /^ENV\s+(.+)$/i.exec(instruction);
  if (!envMatch) return undefined;
  const words = tokenizeDockerfileWords(envMatch[1]!);
  if (!words || words.length === 0) return undefined;

  if (!words[0]!.raw.includes("=")) {
    if (words[0]!.decoded !== key) return undefined;
    return {
      decoded: words
        .slice(1)
        .map((word) => word.decoded)
        .join(" "),
      raw: words
        .slice(1)
        .map((word) => word.raw)
        .join(" "),
    };
  }

  let value: DockerfileWord | undefined;
  for (const word of words) {
    const rawEquals = word.raw.indexOf("=");
    const decodedEquals = word.decoded.indexOf("=");
    if (rawEquals > 0 && decodedEquals > 0 && word.raw.slice(0, rawEquals) === key) {
      value = {
        decoded: word.decoded.slice(decodedEquals + 1),
        raw: word.raw.slice(rawEquals + 1),
      };
    }
  }
  return value;
}

function dockerfileInstructions(dockerfile: string): DockerfileInstruction[] {
  const instructions: DockerfileInstruction[] = [];
  const pendingHeredocs: DockerfileHeredoc[] = [];
  let current = "";
  let currentStart = -1;

  for (const match of dockerfile.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const lineStart = match.index;
    const lineWithEnding = match[0];
    const lineWithoutLf = lineWithEnding.endsWith("\n")
      ? lineWithEnding.slice(0, -1)
      : lineWithEnding;
    const rawLine = lineWithoutLf.endsWith("\r") ? lineWithoutLf.slice(0, -1) : lineWithoutLf;
    const pendingHeredoc = pendingHeredocs[0];
    if (pendingHeredoc) {
      const candidate = pendingHeredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
      if (candidate === pendingHeredoc.delimiter) pendingHeredocs.shift();
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!current) currentStart = lineStart;
    const continued = trimmed.endsWith("\\");
    const part = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    current = current ? `${current} ${part}` : part;
    if (!continued) {
      instructions.push({
        text: current,
        start: currentStart,
        end: lineStart + rawLine.length,
      });
      pendingHeredocs.push(...dockerfileHeredocs(current));
      current = "";
      currentStart = -1;
    }
  }
  if (current) {
    instructions.push({ text: current, start: currentStart, end: dockerfile.length });
    pendingHeredocs.push(...dockerfileHeredocs(current));
  }
  if (pendingHeredocs.length > 0) {
    throw new Error(
      `Custom Dockerfile contains an unterminated heredoc '${pendingHeredocs[0]!.delimiter}'.`,
    );
  }
  return instructions;
}

function validateToolDisclosureDockerfileContract(
  dockerfile: string,
  toolDisclosure: ToolDisclosure,
): DockerfileInstruction {
  const instructions = dockerfileInstructions(dockerfile);
  const declarations = instructions.filter((instruction) =>
    /^ARG\s+NEMOCLAW_TOOL_DISCLOSURE\s*=/.test(instruction.text),
  );
  if (declarations.length !== 1) {
    const detail = declarations.length === 0 ? "does not declare" : "declares more than once";
    throw new Error(
      `Custom Dockerfile ${detail} ARG NEMOCLAW_TOOL_DISCLOSURE; exactly one final-stage declaration is required to apply tool disclosure '${toolDisclosure}'.`,
    );
  }

  const finalFromIndex = instructions.reduce(
    (last, instruction, index) => (/^FROM(?:\s|$)/i.test(instruction.text) ? index : last),
    -1,
  );
  const finalStage = instructions.slice(finalFromIndex + 1);
  if (!finalStage.includes(declarations[0]!)) {
    throw new Error(
      `Custom Dockerfile declares ARG NEMOCLAW_TOOL_DISCLOSURE outside the final stage; cannot apply tool disclosure '${toolDisclosure}'.`,
    );
  }

  const finalEnvAssignments = finalStage
    .map((instruction, index) => ({
      index,
      value: dockerfileEnvValue(instruction.text, "NEMOCLAW_TOOL_DISCLOSURE"),
    }))
    .filter((assignment) => assignment.value !== undefined);
  const lastEnvAssignment = finalEnvAssignments.at(-1);
  const declarationIndex = finalStage.indexOf(declarations[0]!);
  const expandableRuntimeValues = new Set([
    "${NEMOCLAW_TOOL_DISCLOSURE}",
    "$NEMOCLAW_TOOL_DISCLOSURE",
    '"${NEMOCLAW_TOOL_DISCLOSURE}"',
    '"$NEMOCLAW_TOOL_DISCLOSURE"',
  ]);
  const promotesToFinalRuntime = Boolean(
    lastEnvAssignment &&
      lastEnvAssignment.index > declarationIndex &&
      expandableRuntimeValues.has(lastEnvAssignment.value!.raw),
  );
  if (!promotesToFinalRuntime) {
    throw new Error(
      `Custom Dockerfile must promote ARG NEMOCLAW_TOOL_DISCLOSURE into the final-stage ENV after its declaration, with no later override; cannot apply tool disclosure '${toolDisclosure}'.`,
    );
  }
  return declarations[0]!;
}

export function assertToolDisclosureDockerfileContract(
  dockerfilePath: string,
  toolDisclosure: ToolDisclosure,
): void {
  let dockerfile: string;
  try {
    dockerfile = readExistingDockerfileNoFollow(dockerfilePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new Error(`Custom Dockerfile not found: ${dockerfilePath}`);
    }
    if (error instanceof Error && error.message.includes("non-regular Dockerfile")) {
      throw new Error(`Custom Dockerfile path is not a file: ${dockerfilePath}`);
    }
    throw error;
  }
  validateToolDisclosureDockerfileContract(dockerfile, toolDisclosure);
}

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
  let dockerfile = readExistingDockerfileNoFollow(dockerfilePath);
  const toolDisclosure = normalizeToolDisclosure(options.toolDisclosure) ?? DEFAULT_TOOL_DISCLOSURE;
  const toolDisclosureInstruction = options.requireToolDisclosureContract
    ? validateToolDisclosureDockerfileContract(dockerfile, toolDisclosure)
    : dockerfileInstructions(dockerfile).find((instruction) =>
        /^ARG\s+NEMOCLAW_TOOL_DISCLOSURE\s*=/.test(instruction.text),
      );
  if (toolDisclosureInstruction) {
    dockerfile = `${dockerfile.slice(0, toolDisclosureInstruction.start)}ARG NEMOCLAW_TOOL_DISCLOSURE=${sanitizeDockerArg(toolDisclosure)}${dockerfile.slice(toolDisclosureInstruction.end)}`;
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
    `ARG NEMOCLAW_WEB_SEARCH_ENABLED=${sanitizeDockerArg(webSearchConfig ? "1" : "0")}`,
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
  writeExistingDockerfileNoFollow(dockerfilePath, dockerfile);
}
