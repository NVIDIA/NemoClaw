// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import YAML from "yaml";

import { redact } from "../../security/redact";
import type {
  ChannelHookPhase,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingJsonRenderPlan,
  SandboxMessagingPlan,
} from "../manifest";
import type { MessagingHookOutputMap } from "../hooks";
import {
  MESSAGING_SETUP_APPLIER_ENV_KEY,
  type MessagingCredentialApplyOptions,
  type MessagingCredentialApplyResult,
  type MessagingHookApplyRequest,
  type MessagingHookApplyRunner,
  type MessagingOpenShellRunner,
  type MessagingPolicyApplyOptions,
  type MessagingPolicyApplyResult,
  type MessagingSetupEnvOptions,
} from "./types";

type MessagingCredentialApplyEntry = MessagingCredentialApplyResult["upserted"][number];
type MessagingCredentialReuseEntry = MessagingCredentialApplyResult["reused"][number];
type MessagingMissingCredentialEntry = MessagingCredentialApplyResult["missing"][number];
type MessagingCredentialBindingLike = Pick<
  SandboxMessagingCredentialBindingPlan,
  "channelId" | "credentialId" | "providerName" | "providerEnvKey"
>;

const AGENT_CONFIG_HOOK_PHASES = new Set<ChannelHookPhase>([
  "apply",
  "post-agent-install",
]);

export class MessagingSetupApplier {
  static encodePlan(plan: SandboxMessagingPlan): string {
    assertSandboxMessagingPlan(plan);
    assertJsonSerializable(plan);
    return Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
  }

  static decodePlan(encoded: string): SandboxMessagingPlan {
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    assertSandboxMessagingPlan(parsed);
    return parsed;
  }

  static writePlanToEnv(
    plan: SandboxMessagingPlan,
    options: MessagingSetupEnvOptions = {},
  ): void {
    const env = options.env ?? process.env;
    env[options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY] = this.encodePlan(plan);
  }

  static readPlanFromEnv(options: MessagingSetupEnvOptions = {}): SandboxMessagingPlan | null {
    const env = options.env ?? process.env;
    const value = env[options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY];
    return value ? this.decodePlan(value) : null;
  }

  static requirePlanFromEnv(options: MessagingSetupEnvOptions = {}): SandboxMessagingPlan {
    const plan = this.readPlanFromEnv(options);
    if (!plan) {
      throw new Error(`${options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY} is not set.`);
    }
    return plan;
  }

  static clearPlanEnv(options: MessagingSetupEnvOptions = {}): void {
    const env = options.env ?? process.env;
    delete env[options.envKey ?? MESSAGING_SETUP_APPLIER_ENV_KEY];
  }

  static listHookRequests(
    plan: SandboxMessagingPlan,
    phase?: ChannelHookPhase,
  ): MessagingHookApplyRequest[] {
    assertSandboxMessagingPlan(plan);
    return plan.channels.flatMap((channel) =>
      channel.hooks
        .filter((hook) => !phase || hook.phase === phase)
        .map((hook) => toHookApplyRequest(plan, channel, hook)),
    );
  }

  static async applyAgentConfigAtOpenShell(
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
    assertSandboxMessagingPlan(plan);
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

    for (const [target, render] of groupRenderByTarget(plan.agentRender)) {
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
        plan.agentRender.flatMap((render) => render.templateRefs),
      ),
    };
  }

  static applyCredentialsAtOpenShell(
    plan: SandboxMessagingPlan,
    options: MessagingCredentialApplyOptions,
  ): MessagingCredentialApplyResult {
    assertSandboxMessagingPlan(plan);
    const env = options.env ?? process.env;
    const runOpenshell = options.runOpenshell;
    const upserted: MessagingCredentialApplyEntry[] = [];
    const reused: MessagingCredentialReuseEntry[] = [];
    const missing: MessagingMissingCredentialEntry[] = [];

    for (const binding of plan.credentialBindings) {
      const credential = readCredentialEnv(env, binding.providerEnvKey);
      if (!credential) {
        if (providerExistsInGateway(binding.providerName, runOpenshell)) {
          reused.push(toReuseEntry(binding));
        } else {
          missing.push(toMissingEntry(binding));
        }
        continue;
      }

      const action = providerExistsInGateway(binding.providerName, runOpenshell)
        ? "update"
        : "create";
      const result = runOpenshell(
        buildProviderArgs(action, binding.providerName, binding.providerEnvKey),
        {
          ignoreError: true,
          env: { [binding.providerEnvKey]: credential },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const status = result.status ?? 0;
      if (status !== 0) {
        throw new Error(
          `Failed to ${action} messaging provider '${binding.providerName}': ${compactOutput(result)}`,
        );
      }
      upserted.push({
        channelId: binding.channelId,
        credentialId: binding.credentialId,
        providerName: binding.providerName,
        envKey: binding.providerEnvKey,
        action,
      });
    }

    const providerNames = uniqueStrings([
      ...upserted.map((entry) => entry.providerName),
      ...reused.map((entry) => entry.providerName),
    ]);

    return {
      upserted,
      reused,
      missing,
      providerNames,
      sandboxCreateProviderArgs: providerNames.flatMap((providerName) => [
        "--provider",
        providerName,
      ]),
    };
  }

  static applyPolicyAtOpenShell(
    plan: SandboxMessagingPlan,
    options: MessagingPolicyApplyOptions,
  ): MessagingPolicyApplyResult {
    assertSandboxMessagingPlan(plan);
    const activePresets = uniqueStrings(plan.networkPolicy.presets);
    if (activePresets.length > 0 && !options.applyPresets(plan.sandboxName, activePresets)) {
      throw new Error(`Failed to apply messaging policy preset(s): ${activePresets.join(", ")}`);
    }

    return {
      appliedPresets: activePresets,
    };
  }
}

function hookRequestsForPhases(
  plan: SandboxMessagingPlan,
  phases: ReadonlySet<ChannelHookPhase>,
): MessagingHookApplyRequest[] {
  return plan.channels.flatMap((channel) =>
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

function assertSandboxMessagingPlan(value: unknown): asserts value is SandboxMessagingPlan {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sandboxName !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.workflow !== "string" ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.credentialBindings) ||
    !isObject(value.networkPolicy) ||
    !Array.isArray(value.agentRender) ||
    !Array.isArray(value.buildSteps) ||
    !Array.isArray(value.stateUpdates) ||
    !Array.isArray(value.healthChecks)
  ) {
    throw new Error("Expected a serializable SandboxMessagingPlan.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonSerializable(
  value: unknown,
  path = "$",
  visiting: Set<object> = new Set(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    assertAcyclicObject(value, path, visiting, () => {
      value.forEach((entry, index) => assertJsonSerializable(entry, `${path}[${index}]`, visiting));
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    assertAcyclicObject(value, path, visiting, () => {
      for (const [key, entry] of Object.entries(value)) {
        assertJsonSerializable(entry, `${path}.${key}`, visiting);
      }
    });
    return;
  }
  throw new Error(`Messaging setup plan is not JSON-serializable at ${path}.`);
}

function assertAcyclicObject(
  value: object,
  path: string,
  visiting: Set<object>,
  visit: () => void,
): void {
  if (visiting.has(value)) {
    throw new Error(`Messaging setup plan contains a cycle at ${path}.`);
  }
  visiting.add(value);
  try {
    visit();
  } finally {
    visiting.delete(value);
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
    const next = cursor[segment];
    if (!isObject(next)) {
      const created: Record<string, MessagingSerializableValue> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, MessagingSerializableValue>;
    }
  }
  cursor[segments[segments.length - 1] as string] = value;
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
  if (mode !== undefined && typeof mode !== "string") {
    throw new Error(`Messaging build-file '${path}' mode must be a string.`);
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
    const existing = target[key];
    if (isObject(existing) && isObject(value)) {
      mergeObjects(
        existing as Record<string, MessagingSerializableValue>,
        value as Record<string, MessagingSerializableValue>,
      );
      continue;
    }
    target[key] = value;
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

function resolveHookBuildFileTarget(path: string, agent: MessagingAgentId): string {
  if (path.startsWith("/")) return path;
  if (path === "openclaw.json") return resolveSandboxAgentConfigTarget(path, "openclaw");
  if (path === "config.yaml" && agent === "hermes") {
    return resolveSandboxAgentConfigTarget("~/.hermes/config.yaml", agent);
  }
  if (path === ".env" && agent === "hermes") {
    return resolveSandboxAgentConfigTarget("~/.hermes/.env", agent);
  }
  if (agent === "openclaw") return `/sandbox/.openclaw/${path}`;
  if (agent === "hermes") return `/sandbox/.hermes/${path}`;
  throw new Error(`Cannot resolve messaging build-file target '${path}' for ${agent}.`);
}

function resolveSandboxAgentConfigTarget(target: string, agent: MessagingAgentId): string {
  if (target.startsWith("/")) return target;
  if (agent === "openclaw" && target === "openclaw.json") {
    return "/sandbox/.openclaw/openclaw.json";
  }
  if (target.startsWith("~/.openclaw/")) {
    return `/sandbox/.openclaw/${target.slice("~/.openclaw/".length)}`;
  }
  if (target.startsWith("~/.hermes/")) {
    return `/sandbox/.hermes/${target.slice("~/.hermes/".length)}`;
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

function readCredentialEnv(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const raw = env[envKey];
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/\r/g, "").trim();
  return normalized || null;
}

function providerExistsInGateway(
  providerName: string,
  runOpenshell: MessagingOpenShellRunner,
): boolean {
  const result = runOpenshell(["provider", "get", providerName], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return (result.status ?? 0) === 0;
}

function buildProviderArgs(
  action: "create" | "update",
  providerName: string,
  credentialEnv: string,
): string[] {
  return action === "create"
    ? [
        "provider",
        "create",
        "--name",
        providerName,
        "--type",
        "generic",
        "--credential",
        credentialEnv,
      ]
    : ["provider", "update", providerName, "--credential", credentialEnv];
}

function toReuseEntry(binding: MessagingCredentialBindingLike): MessagingCredentialReuseEntry {
  return {
    channelId: binding.channelId,
    credentialId: binding.credentialId,
    providerName: binding.providerName,
    envKey: binding.providerEnvKey,
  };
}

function toMissingEntry(binding: MessagingCredentialBindingLike): MessagingMissingCredentialEntry {
  return {
    channelId: binding.channelId,
    credentialId: binding.credentialId,
    providerName: binding.providerName,
    envKey: binding.providerEnvKey,
  };
}

function compactOutput(result: { readonly stdout?: unknown; readonly stderr?: unknown }): string {
  const output = redact(`${String(result.stderr ?? "")}${String(result.stdout ?? "")}`)
    .replace(/\r/g, "")
    .trim();
  return output || "OpenShell command failed.";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
