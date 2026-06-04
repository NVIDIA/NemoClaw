// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { posix as path } from "node:path";

import YAML from "yaml";

import { redact } from "../../security/redact";
import type {
  ChannelHookPhase,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingJsonRenderPlan,
  SandboxMessagingPlan,
} from "../manifest";
import type { MessagingHookOutputMap } from "../hooks";
import type {
  MessagingHookApplyRequest,
  MessagingHookApplyRunner,
  MessagingOpenShellRunner,
} from "./types";
import { enabledPlanChannels, filterEnabledPlanEntries } from "./plan-filter";

const AGENT_CONFIG_HOOK_PHASES = new Set<ChannelHookPhase>([
  "apply",
  "post-agent-install",
]);

export function listHookRequests(
  plan: SandboxMessagingPlan,
  phase?: ChannelHookPhase,
): MessagingHookApplyRequest[] {
  return enabledPlanChannels(plan).flatMap((channel) =>
    channel.hooks
      .filter((hook) => !phase || hook.phase === phase)
      .map((hook) => toHookApplyRequest(plan, channel, hook)),
  );
}

export async function applyAgentConfigAtOpenShell(
  plan: SandboxMessagingPlan,
  options: {
    readonly runOpenshell: MessagingOpenShellRunner;
    readonly runHook?: MessagingHookApplyRunner;
  },
): Promise<{
  readonly appliedTargets: readonly string[];
  readonly appliedHooks: readonly string[];
  readonly unresolvedTemplateRefs: readonly string[];
}> {
  const hookRequests = hookRequestsForPhases(plan, AGENT_CONFIG_HOOK_PHASES);
  if (hookRequests.length > 0 && !options.runHook) {
    throw new Error("Messaging agent config hooks require a hook runner.");
  }

  const appliedHooks: string[] = [];
  const appliedTargets: string[] = [];
  for (const request of hookRequests.filter((hook) => hook.phase === "apply")) {
    await runApplyHook(request, options.runHook, plan, options.runOpenshell, {
      appliedHooks,
      appliedTargets,
    });
  }

  const enabledRender = filterEnabledPlanEntries(plan, plan.agentRender);

  for (const [target, render] of groupRenderByTarget(enabledRender)) {
    const resolvedTarget = resolveSandboxAgentConfigTarget(target, plan.agent);
    const kind = render[0]?.kind;
    if (!kind) continue;
    if (render.some((entry) => entry.kind !== kind)) {
      throw new Error(`Cannot apply mixed messaging render kinds to ${target}.`);
    }
    const existing = readSandboxFile(plan.sandboxName, resolvedTarget, options.runOpenshell);
    const contents =
      kind === "json-fragment"
        ? applyJsonFragments(
            existing,
            render.filter(isJsonRender),
            resolvedTarget,
          )
        : applyEnvLines(existing, render.filter(isEnvLinesRender));
    writeSandboxFile(plan.sandboxName, resolvedTarget, contents, options.runOpenshell);
    appliedTargets.push(resolvedTarget);
  }

  for (const request of hookRequests.filter((hook) => hook.phase === "post-agent-install")) {
    await runApplyHook(request, options.runHook, plan, options.runOpenshell, {
      appliedHooks,
      appliedTargets,
    });
  }

  return {
    appliedTargets: uniqueStrings(appliedTargets),
    appliedHooks,
    unresolvedTemplateRefs: uniqueStrings(
      enabledRender.flatMap((render) => render.templateRefs),
    ),
  };
}

function hookRequestsForPhases(
  plan: SandboxMessagingPlan,
  phases: ReadonlySet<ChannelHookPhase>,
): MessagingHookApplyRequest[] {
  return enabledPlanChannels(plan).flatMap((channel) =>
    channel.hooks
      .filter((hook) => phases.has(hook.phase))
      .map((hook) => toHookApplyRequest(plan, channel, hook)),
  );
}

function toHookApplyRequest(
  plan: SandboxMessagingPlan,
  channel: SandboxMessagingChannelPlan,
  hook: SandboxMessagingChannelPlan["hooks"][number],
): MessagingHookApplyRequest {
  const inputs = buildHookInputMap(plan, channel);
  const selectedInputs = hook.inputs
    ? Object.fromEntries(
        hook.inputs
          .filter((inputKey) => Object.hasOwn(inputs, inputKey))
          .map((inputKey) => [inputKey, inputs[inputKey] as MessagingSerializableValue]),
      )
    : inputs;

  return {
    sandboxName: plan.sandboxName,
    agent: plan.agent,
    channelId: channel.channelId,
    hookId: hook.id,
    phase: hook.phase,
    handler: hook.handler,
    inputKeys: hook.inputs,
    inputs: selectedInputs,
    outputs: hook.outputs,
    onFailure: hook.onFailure,
  };
}

function buildHookInputMap(
  plan: SandboxMessagingPlan,
  channel: SandboxMessagingChannelPlan,
): Record<string, MessagingSerializableValue> {
  const inputs: Record<string, MessagingSerializableValue> = {};
  for (const input of channel.inputs) {
    if (input.value === undefined) continue;
    inputs[input.inputId] = input.value;
    if (input.statePath) inputs[input.statePath] = input.value;
  }
  for (const credential of plan.credentialBindings) {
    if (credential.channelId !== channel.channelId) continue;
    inputs[`credential.${credential.credentialId}.placeholder`] = credential.placeholder;
  }
  return inputs;
}

async function runApplyHook(
  request: MessagingHookApplyRequest,
  runner: MessagingHookApplyRunner | undefined,
  plan: SandboxMessagingPlan,
  runOpenshell: MessagingOpenShellRunner,
  applied: {
    readonly appliedHooks: string[];
    readonly appliedTargets: string[];
  },
): Promise<void> {
  if (!runner) return;
  try {
    const result = await runner(request);
    applied.appliedHooks.push(`${request.channelId}:${request.hookId}`);
    if (result?.outputs) {
      applied.appliedTargets.push(
        ...applyHookBuildFileOutputs(plan, result.outputs, runOpenshell),
      );
    }
  } catch (error) {
    if (request.onFailure === "skip-channel") return;
    throw error;
  }
}

function groupRenderByTarget(
  render: readonly SandboxMessagingAgentRenderPlan[],
): ReadonlyMap<string, SandboxMessagingAgentRenderPlan[]> {
  const groups = new Map<string, SandboxMessagingAgentRenderPlan[]>();
  for (const entry of render) {
    const group = groups.get(entry.target) ?? [];
    group.push(entry);
    groups.set(entry.target, group);
  }
  return groups;
}

function isJsonRender(
  render: SandboxMessagingAgentRenderPlan,
): render is SandboxMessagingJsonRenderPlan {
  return render.kind === "json-fragment";
}

function isEnvLinesRender(
  render: SandboxMessagingAgentRenderPlan,
): render is SandboxMessagingEnvLinesRenderPlan {
  return render.kind === "env-lines";
}

function applyJsonFragments(
  existing: string | undefined,
  render: readonly SandboxMessagingJsonRenderPlan[],
  target: string,
): string {
  const format = target.endsWith(".yaml") || target.endsWith(".yml") ? "yaml" : "json";
  const root = parseStructuredConfig(existing, target, format);
  for (const entry of render) {
    setJsonPath(root, entry.path, entry.value);
  }
  return format === "yaml" ? YAML.stringify(root) : `${JSON.stringify(root, null, 2)}\n`;
}

function parseStructuredConfig(
  existing: string | undefined,
  target: string,
  format: "json" | "yaml",
): Record<string, MessagingSerializableValue> {
  if (!existing || existing.trim().length === 0) return {};
  const parsed = format === "yaml" ? YAML.parse(existing) : (JSON.parse(existing) as unknown);
  if (!isObject(parsed)) {
    throw new Error(`Messaging agent config target ${target} must contain an object.`);
  }
  return parsed as Record<string, MessagingSerializableValue>;
}

function setJsonPath(
  root: Record<string, MessagingSerializableValue>,
  path: string,
  value: MessagingSerializableValue,
): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("Messaging render path must not be empty.");
  }
  let cursor: Record<string, MessagingSerializableValue> = root;
  for (const segment of segments.slice(0, -1)) {
    assertSafeObjectKey(segment, "Messaging render path");
    const next = cursor[segment];
    if (!isObject(next)) {
      const created: Record<string, MessagingSerializableValue> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, MessagingSerializableValue>;
    }
  }
  const finalSegment = segments[segments.length - 1] as string;
  assertSafeObjectKey(finalSegment, "Messaging render path");
  cursor[finalSegment] = value;
}

function applyEnvLines(
  existing: string | undefined,
  render: readonly SandboxMessagingEnvLinesRenderPlan[],
): string {
  const desired = new Map<string, string>();
  const rawDesiredLines: string[] = [];
  for (const entry of render) {
    for (const line of entry.lines) {
      const key = readEnvLineKey(line);
      if (key) {
        desired.set(key, line);
      } else {
        rawDesiredLines.push(line);
      }
    }
  }

  const written = new Set<string>();
  const output = (existing ?? "")
    .split(/\n/)
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .map((line) => {
      const key = readEnvLineKey(line);
      if (!key || !desired.has(key)) return line;
      written.add(key);
      return desired.get(key) as string;
    });

  for (const [key, line] of desired) {
    if (!written.has(key)) output.push(line);
  }
  output.push(...rawDesiredLines);
  return output.length > 0 ? `${output.join("\n")}\n` : "";
}

function readEnvLineKey(line: string): string | null {
  const index = line.indexOf("=");
  if (index <= 0) return null;
  const key = line.slice(0, index).trim();
  return key.length > 0 ? key : null;
}

function applyHookBuildFileOutputs(
  plan: SandboxMessagingPlan,
  outputs: MessagingHookOutputMap,
  runOpenshell: MessagingOpenShellRunner,
): string[] {
  const appliedTargets: string[] = [];
  for (const output of Object.values(outputs)) {
    if (output.kind !== "build-file") continue;
    const file = readHookBuildFile(output.value);
    const target = resolveHookBuildFileTarget(file.path, plan.agent);
    const contents =
      file.merge !== undefined
        ? applyStructuredMerge(
            readSandboxFile(plan.sandboxName, target, runOpenshell),
            file.merge,
            target,
          )
        : serializeHookBuildFileContent(file.content, target);
    writeSandboxFile(plan.sandboxName, target, contents, runOpenshell, file.mode);
    appliedTargets.push(target);
  }
  return appliedTargets;
}

function readHookBuildFile(value: MessagingSerializableValue): {
  readonly path: string;
  readonly mode?: string;
  readonly content?: MessagingSerializableValue;
  readonly merge?: MessagingSerializableValue;
} {
  if (!isObject(value) || typeof value.path !== "string" || value.path.trim().length === 0) {
    throw new Error("Messaging build-file hook output must include a non-empty path.");
  }
  const file = value as Record<string, MessagingSerializableValue | undefined>;
  const path = value.path;
  const mode = value.mode;
  if (file.content === undefined && file.merge === undefined) {
    throw new Error(`Messaging build-file '${path}' must include content or merge.`);
  }
  if (mode !== undefined) {
    if (typeof mode !== "string") {
      throw new Error(`Messaging build-file '${path}' mode must be a string.`);
    }
    assertSafeFileMode(path, mode);
  }
  return {
    path,
    mode,
    content: file.content,
    merge: file.merge,
  };
}

function applyStructuredMerge(
  existing: string | undefined,
  patch: MessagingSerializableValue,
  target: string,
): string {
  if (!isObject(patch)) {
    throw new Error(`Messaging build-file merge for ${target} must be an object.`);
  }
  const format = target.endsWith(".yaml") || target.endsWith(".yml") ? "yaml" : "json";
  const root = parseStructuredConfig(existing, target, format);
  mergeObjects(root, patch);
  return format === "yaml" ? YAML.stringify(root) : `${JSON.stringify(root, null, 2)}\n`;
}

function mergeObjects(
  target: Record<string, MessagingSerializableValue>,
  patch: Record<string, MessagingSerializableValue>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`Messaging build-file merge rejected unsafe object key '${key}'.`);
    }
    const existing = target[key];
    if (isObject(existing) && isObject(value)) {
      mergeObjects(
        existing as Record<string, MessagingSerializableValue>,
        value as Record<string, MessagingSerializableValue>,
      );
      continue;
    }
    validateSafeMergeValue(value);
    target[key] = value;
  }
}

function validateSafeMergeValue(value: MessagingSerializableValue): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      validateSafeMergeValue(entry);
    }
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`Messaging build-file merge rejected unsafe object key '${key}'.`);
    }
    validateSafeMergeValue(entry as MessagingSerializableValue);
  }
}

function serializeHookBuildFileContent(
  content: MessagingSerializableValue | undefined,
  target: string,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content.endsWith("\n") ? content : `${content}\n`;
  if (target.endsWith(".yaml") || target.endsWith(".yml")) return YAML.stringify(content);
  return `${JSON.stringify(content, null, 2)}\n`;
}

// Source-of-truth boundary for sandbox file writes: plans and hook outputs are
// serialized data that can outlive their producing manifest/hook code. Validate
// every target here before invoking OpenShell so future channels cannot bypass
// the agent-owned /sandbox config roots by returning raw paths.
function resolveHookBuildFileTarget(filePath: string, agent: MessagingAgentId): string {
  const normalizedPath = normalizeRelativeAgentPath(filePath, "Messaging build-file path");
  const root = sandboxAgentConfigRoot(agent);
  let target: string;
  if (normalizedPath === "openclaw.json") {
    target = resolveSandboxAgentConfigTarget(normalizedPath, "openclaw");
  } else if (normalizedPath === "config.yaml" && agent === "hermes") {
    target = resolveSandboxAgentConfigTarget("~/.hermes/config.yaml", agent);
  } else if (normalizedPath === ".env" && agent === "hermes") {
    target = resolveSandboxAgentConfigTarget("~/.hermes/.env", agent);
  } else {
    target = `${root}/${normalizedPath}`;
  }
  assertSandboxPathUnderRoot(target, root, filePath, "Messaging build-file path");
  return target;
}

function normalizeRelativeAgentPath(filePath: string, context: string): string {
  if (filePath.trim().length === 0) {
    throw new Error(`${context} must not be empty.`);
  }
  if (filePath.startsWith("/") || filePath.includes("\\") || /[\0-\x1F\x7F]/.test(filePath)) {
    throw new Error(`${context} '${filePath}' must be a safe relative path.`);
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    throw new Error(`${context} '${filePath}' must not contain empty segments.`);
  }
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${context} '${filePath}' must not traverse directories.`);
  }
  const normalizedPath = path.normalize(filePath);
  if (
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.startsWith("/")
  ) {
    throw new Error(`${context} '${filePath}' must stay inside agent config.`);
  }
  return normalizedPath;
}

function sandboxAgentConfigRoot(agent: MessagingAgentId): string {
  if (agent === "openclaw") return "/sandbox/.openclaw";
  if (agent === "hermes") return "/sandbox/.hermes";
  throw new Error(`Cannot resolve messaging build-file root for ${agent}.`);
}

function assertSandboxPathUnderRoot(
  target: string,
  root: string,
  sourcePath: string,
  context: string,
): void {
  const relative = path.relative(root, target);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${context} '${sourcePath}' must stay inside ${root}.`);
  }
}

function assertSafeFileMode(filePath: string, mode: string): void {
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new Error(`Messaging build-file '${filePath}' mode must be an octal file mode.`);
  }
  if (mode.length === 4 && mode[0] !== "0") {
    throw new Error(`Messaging build-file '${filePath}' mode must not set special bits.`);
  }
  const parsedMode = Number.parseInt(mode, 8);
  if ((parsedMode & 0o022) !== 0) {
    throw new Error(`Messaging build-file '${filePath}' mode must not be group/world writable.`);
  }
}

function resolveSandboxAgentConfigTarget(target: string, agent: MessagingAgentId): string {
  const root = sandboxAgentConfigRoot(agent);
  if (target.startsWith("/")) {
    const normalizedTarget = path.normalize(target);
    assertSandboxPathUnderRoot(normalizedTarget, root, target, "Messaging render target");
    return normalizedTarget;
  }
  if (agent === "openclaw" && target === "openclaw.json") {
    return "/sandbox/.openclaw/openclaw.json";
  }
  if (target.startsWith("~/.openclaw/")) {
    if (agent !== "openclaw") {
      throw new Error(`Cannot apply OpenClaw messaging target '${target}' for ${agent}.`);
    }
    const suffix = normalizeRelativeAgentPath(
      target.slice("~/.openclaw/".length),
      "Messaging render target",
    );
    const resolved = `${root}/${suffix}`;
    assertSandboxPathUnderRoot(resolved, root, target, "Messaging render target");
    return resolved;
  }
  if (target.startsWith("~/.hermes/")) {
    if (agent !== "hermes") {
      throw new Error(`Cannot apply Hermes messaging target '${target}' for ${agent}.`);
    }
    const suffix = normalizeRelativeAgentPath(
      target.slice("~/.hermes/".length),
      "Messaging render target",
    );
    const resolved = `${root}/${suffix}`;
    assertSandboxPathUnderRoot(resolved, root, target, "Messaging render target");
    return resolved;
  }
  throw new Error(`Cannot resolve messaging agent config target '${target}' for ${agent}.`);
}

function readSandboxFile(
  sandboxName: string,
  target: string,
  runOpenshell: MessagingOpenShellRunner,
): string | undefined {
  const result = runOpenshell(
    ["sandbox", "exec", "--name", sandboxName, "--", "cat", target],
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const status = result.status ?? 0;
  return status === 0 ? String(result.stdout ?? "") : undefined;
}

function writeSandboxFile(
  sandboxName: string,
  target: string,
  contents: string,
  runOpenshell: MessagingOpenShellRunner,
  mode?: string,
): void {
  const result = runOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      mode
        ? 'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"'
        : 'mkdir -p "$(dirname "$1")" && cat > "$1"',
      "sh",
      target,
      ...(mode ? [mode] : []),
    ],
    {
      input: contents,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const status = result.status ?? 0;
  if (status !== 0) {
    throw new Error(
      `Failed to apply messaging agent config '${target}': ${compactOutput(result)}`,
    );
  }
}

function compactOutput(result: { readonly stdout?: unknown; readonly stderr?: unknown }): string {
  const output = redact(`${String(result.stderr ?? "")}${String(result.stdout ?? "")}`)
    .replace(/\r/g, "")
    .trim();
  return output || "OpenShell command failed.";
}

function assertSafeObjectKey(key: string, context: string): void {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error(`${context} rejected unsafe object key '${key}'.`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
