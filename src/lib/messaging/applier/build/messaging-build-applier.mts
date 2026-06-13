#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, any>;
type MessagingAgentId = "openclaw" | "hermes";
type MessagingHookPhase = "agent-install" | "post-agent-install";
type MessagingSerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly MessagingSerializableValue[]
  | { readonly [key: string]: MessagingSerializableValue };

type MessagingPlanChannel = {
  readonly channelId: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly hooks?: readonly MessagingPlanHook[];
};

type MessagingCredentialBinding = {
  readonly channelId: string;
  readonly credentialId?: string;
  readonly providerEnvKey?: unknown;
  readonly placeholder?: unknown;
};

type MessagingPlanHook = {
  readonly id: string;
  readonly phase: string;
  readonly handler: string;
  readonly outputs?: readonly MessagingPlanHookOutput[];
  readonly onFailure?: "abort" | "skip-channel";
};

type MessagingPlanHookOutput = {
  readonly id: string;
  readonly kind: string;
  readonly required?: boolean;
  readonly value?: MessagingSerializableValue;
};

type MessagingRenderEntry = {
  readonly channelId: string;
  readonly agent: MessagingAgentId;
  readonly target: string;
  readonly kind: "json-fragment" | "env-lines";
  readonly renderId?: string;
  readonly hookId?: string;
  readonly handler?: string;
  readonly path?: string;
  readonly value?: MessagingSerializableValue;
  readonly lines?: readonly string[];
  readonly templateRefs?: readonly string[];
};

type MessagingBuildStep = {
  readonly channelId: string;
  readonly kind: "build-arg" | "build-file" | "package-install";
  readonly hookId?: string;
  readonly handler?: string;
  readonly outputId: string;
  readonly required?: boolean;
  readonly value?: MessagingSerializableValue;
};

export type MessagingBuildPlan = {
  readonly schemaVersion: 1;
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly channels: readonly MessagingPlanChannel[];
  readonly credentialBindings: readonly MessagingCredentialBinding[];
  readonly agentRender: readonly MessagingRenderEntry[];
  readonly buildSteps: readonly MessagingBuildStep[];
};

export type BuildFileOutput = {
  readonly path: string;
  readonly mode?: string;
  readonly content?: MessagingSerializableValue;
  readonly merge?: MessagingSerializableValue;
};

export type BuildCommandResult = {
  readonly channels: readonly string[];
  readonly doctorEnv: Record<string, string>;
  readonly installSpecs: readonly string[];
  readonly openclawVersion: string;
};

export class MessagingBuildApplierError extends Error {}

const OPENCLAW_VERSIONED_MESSAGING_PLUGIN_PACKAGES: Readonly<Record<string, string>> = {
  discord: "@openclaw/discord",
  slack: "@openclaw/slack",
  whatsapp: "@openclaw/whatsapp",
};

const OPENCLAW_FIXED_MESSAGING_PLUGIN_INSTALL_SPECS: Readonly<Record<string, string>> = {
  wechat: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
};

export function readMessagingBuildPlanFromEnv(
  env: Env,
  agent: MessagingAgentId,
): MessagingBuildPlan | null {
  const encoded = env.NEMOCLAW_MESSAGING_PLAN_B64;
  if (!encoded || encoded.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch (error) {
    throw new MessagingBuildApplierError(
      `NEMOCLAW_MESSAGING_PLAN_B64 must be base64-encoded JSON: ${formatError(error)}`,
    );
  }

  if (
    !isObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.agent !== agent ||
    typeof parsed.sandboxName !== "string" ||
    !Array.isArray(parsed.channels) ||
    !Array.isArray(parsed.credentialBindings) ||
    !Array.isArray(parsed.agentRender) ||
    !Array.isArray(parsed.buildSteps)
  ) {
    throw new MessagingBuildApplierError(
      `NEMOCLAW_MESSAGING_PLAN_B64 must contain a ${agent} messaging plan`,
    );
  }
  return parsed as MessagingBuildPlan;
}

export function applyMessagingAgentRenderToObject(
  config: JsonObject,
  plan: MessagingBuildPlan | null,
  target: string,
): void {
  if (!plan) return;
  const rules = credentialPlaceholderRules(plan);
  for (const render of enabledAgentRender(plan)) {
    if (
      render.kind !== "json-fragment" ||
      render.target !== target ||
      typeof render.path !== "string"
    ) {
      continue;
    }
    const value = preserveCredentialPlaceholders(
      requiredSerializableValue(render.value, "render value"),
      getJsonPath(config, render.path),
      rules,
    );
    setJsonPath(config, render.path, value);
  }
}

export function applyMessagingAgentRenderToEnvLines(
  envLines: string[],
  plan: MessagingBuildPlan | null,
  target: string,
): void {
  if (!plan) return;
  for (const render of enabledAgentRender(plan)) {
    if (render.kind !== "env-lines" || render.target !== target) continue;
    if (!Array.isArray(render.lines)) {
      throw new MessagingBuildApplierError(
        `Messaging env render '${render.renderId ?? render.channelId}' is missing lines.`,
      );
    }
    mergeEnvLines(envLines, readEnvRenderLines(render));
  }
}

export function applyMessagingAgentRenderToLocalFiles(
  plan: MessagingBuildPlan | null,
  options: {
    readonly homeDir?: string;
  } = {},
): readonly string[] {
  if (!plan) return [];
  const appliedTargets: string[] = [];
  const grouped = new Map<string, MessagingRenderEntry[]>();
  for (const render of enabledAgentRender(plan)) {
    const entries = grouped.get(render.target) ?? [];
    entries.push(render);
    grouped.set(render.target, entries);
  }

  for (const [target, renderEntries] of grouped) {
    const kinds = uniqueStrings(renderEntries.map((entry) => entry.kind));
    if (kinds.length !== 1) {
      throw new MessagingBuildApplierError(
        `Cannot apply mixed messaging render kinds to ${target}.`,
      );
    }
    if (kinds[0] === "json-fragment") {
      appliedTargets.push(applyJsonRenderEntriesToLocalFile(plan, target, renderEntries, options));
    } else {
      appliedTargets.push(
        applyEnvRenderEntriesToLocalFile(plan.agent, target, renderEntries, options),
      );
    }
  }

  return uniqueStrings(appliedTargets);
}

export function activeChannels(plan: MessagingBuildPlan | null): string[] {
  if (!plan) return [];
  const seen = new Set<string>();
  const channels: string[] = [];
  for (const item of plan.channels) {
    const channel = String(item.channelId || "")
      .trim()
      .toLowerCase();
    if (!channel || seen.has(channel)) continue;
    if (item.active === true && item.disabled !== true) {
      seen.add(channel);
      channels.push(channel);
    }
  }
  return channels;
}

export function collectOpenClawMessagingPluginInstallSpecs(
  plan: MessagingBuildPlan | null,
  env: Env,
): string[] {
  const specs: string[] = [];
  for (const step of enabledBuildStepsForPhase(plan, "agent-install")) {
    if (step.kind !== "package-install") continue;
    if (step.value === undefined) {
      if (step.required) {
        throw new MessagingBuildApplierError(
          `Messaging package-install output ${step.outputId} is missing`,
        );
      }
      continue;
    }
    const install = readOpenClawPackageInstall(step.value, step.outputId);
    const resolvedSpec = resolveOpenClawPackageSpec(install.spec, env);
    assertAllowedOpenClawPackageSpec(step.channelId, resolvedSpec, env);
    specs.push(resolvedSpec);
  }
  return uniqueStrings(specs);
}

export function openClawDoctorEnvOverrides(
  plan: MessagingBuildPlan | null,
  env: Env = process.env,
): Record<string, string> {
  if (!plan) return {};
  const active = new Set(activeChannels(plan));
  const overrides: Record<string, string> = {};
  for (const binding of plan.credentialBindings) {
    if (!active.has(binding.channelId)) continue;
    if (typeof binding.providerEnvKey === "string" && typeof binding.placeholder === "string") {
      overrides[binding.providerEnvKey] = binding.placeholder;
    }
  }
  if (isTruthyEnv(env.NEMOCLAW_WEB_SEARCH_ENABLED)) {
    overrides.BRAVE_API_KEY = "openshell:resolve:env:BRAVE_API_KEY";
  }
  return overrides;
}

export function installOpenClawMessagingPlugins(plan: MessagingBuildPlan | null, env: Env): void {
  for (const spec of collectOpenClawMessagingPluginInstallSpecs(plan, env)) {
    runCommand(["openclaw", "plugins", "install", spec, "--pin"], env);
  }
}

export function runOpenClawMessagingDoctor(plan: MessagingBuildPlan | null, env: Env): void {
  if (!plan) return;
  runCommand(["openclaw", "doctor", "--fix", "--non-interactive"], {
    ...env,
    ...openClawDoctorEnvOverrides(plan, env),
  });
}

export function applyPostAgentInstallBuildFilesToLocalFiles(
  plan: MessagingBuildPlan | null,
  options: {
    readonly homeDir?: string;
  } = {},
): readonly string[] {
  const appliedTargets: string[] = [];
  for (const step of enabledBuildStepsForPhase(plan, "post-agent-install")) {
    if (step.kind !== "build-file") continue;
    if (step.value === undefined) {
      if (step.required) {
        throw new MessagingBuildApplierError(
          `Messaging build-file output ${step.outputId} is missing`,
        );
      }
      continue;
    }
    appliedTargets.push(
      applyBuildFileOutputToLocalAgentRoot(
        plan?.agent ?? "openclaw",
        readBuildFileOutput(step.value),
        options,
      ),
    );
  }
  return uniqueStrings(appliedTargets);
}

function applyJsonRenderEntriesToLocalFile(
  plan: MessagingBuildPlan,
  target: string,
  renderEntries: readonly MessagingRenderEntry[],
  options: { readonly homeDir?: string },
): string {
  const targetPath = resolveAgentRenderTarget(plan.agent, target, options);
  const config = targetPath.endsWith(".yaml")
    ? parseGeneratedYamlObject(readTextIfExists(targetPath), targetPath)
    : parseJsonObject(readTextIfExists(targetPath), targetPath);
  applyMessagingRenderEntriesToObject(config, renderEntries, target, plan);
  if (plan.agent === "hermes" && target === "~/.hermes/config.yaml") {
    finalizeHermesRenderedPlatformToolsets(config);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    targetPath.endsWith(".yaml")
      ? serializeGeneratedYamlObject(config)
      : `${JSON.stringify(config, null, 2)}\n`,
  );
  chmodSync(targetPath, 0o600);
  return targetPath;
}

function applyEnvRenderEntriesToLocalFile(
  agent: MessagingAgentId,
  target: string,
  renderEntries: readonly MessagingRenderEntry[],
  options: { readonly homeDir?: string },
): string {
  const targetPath = resolveAgentRenderTarget(agent, target, options);
  const envLines =
    readTextIfExists(targetPath)
      ?.split(/\r?\n/)
      .filter((line) => line.length > 0) ?? [];
  for (const render of renderEntries) {
    if (!Array.isArray(render.lines)) {
      throw new MessagingBuildApplierError(
        `Messaging env render '${render.renderId ?? render.channelId}' is missing lines.`,
      );
    }
    mergeEnvLines(envLines, readEnvRenderLines(render));
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, envLines.length > 0 ? `${envLines.join("\n")}\n` : "");
  chmodSync(targetPath, 0o600);
  return targetPath;
}

function applyMessagingRenderEntriesToObject(
  config: JsonObject,
  renderEntries: readonly MessagingRenderEntry[],
  target: string,
  plan: MessagingBuildPlan,
): void {
  const rules = credentialPlaceholderRules(plan);
  for (const render of renderEntries) {
    if (render.kind !== "json-fragment" || typeof render.path !== "string") {
      throw new MessagingBuildApplierError(
        `Messaging render for ${target} must be a JSON fragment with a path.`,
      );
    }
    const value = preserveCredentialPlaceholders(
      requiredSerializableValue(render.value, "render value"),
      getJsonPath(config, render.path),
      rules,
    );
    setJsonPath(config, render.path, value);
  }
}

function readEnvRenderLines(render: MessagingRenderEntry): readonly string[] {
  if (!Array.isArray(render.lines)) {
    throw new MessagingBuildApplierError(
      "Messaging env render '" + (render.renderId ?? render.channelId) + "' is missing lines.",
    );
  }
  for (const line of render.lines) {
    if (/[\r\n]/.test(line)) {
      throw new MessagingBuildApplierError(
        "Messaging env render '" +
          (render.renderId ?? render.channelId) +
          "' must not contain line breaks.",
      );
    }
  }
  return render.lines;
}

function finalizeHermesRenderedPlatformToolsets(config: JsonObject): void {
  const platforms = config.platforms;
  const platformToolsets = config.platform_toolsets;
  if (!isObject(platforms) || !isObject(platformToolsets)) return;
  const apiServerToolsets = platformToolsets.api_server;
  if (!Array.isArray(apiServerToolsets)) return;
  for (const [platform, platformConfig] of Object.entries(platforms)) {
    if (platform === "api_server" || !isObject(platformConfig) || platformConfig.enabled !== true) {
      continue;
    }
    if (!Array.isArray(platformToolsets[platform])) {
      platformToolsets[platform] = [...apiServerToolsets];
    }
  }
}

function resolveAgentRenderTarget(
  agent: MessagingAgentId,
  target: string,
  options: { readonly homeDir?: string } = {},
): string {
  const home = options.homeDir ?? homedir();
  const agentRoot = agent === "hermes" ? join(home, ".hermes") : join(home, ".openclaw");
  const normalizedRoot = resolve(agentRoot);
  if (agent === "openclaw" && target === "openclaw.json") {
    return join(agentRoot, "openclaw.json");
  }
  let relativePath: string | null = null;
  if (target.startsWith("~/.openclaw/")) {
    if (agent !== "openclaw") {
      throw new MessagingBuildApplierError(
        `Messaging render target ${target} does not match ${agent}.`,
      );
    }
    relativePath = target.slice("~/.openclaw/".length);
  }
  if (target.startsWith("~/.hermes/")) {
    if (agent !== "hermes") {
      throw new MessagingBuildApplierError(
        `Messaging render target ${target} does not match ${agent}.`,
      );
    }
    relativePath = target.slice("~/.hermes/".length);
  }
  if (relativePath !== null) {
    const resolvedTarget = resolve(agentRoot, relativePath);
    if (
      resolvedTarget !== normalizedRoot &&
      !resolvedTarget.startsWith(`${normalizedRoot}${sep}`)
    ) {
      throw new MessagingBuildApplierError(
        `Messaging render target ${target} must stay inside ${agentRoot}.`,
      );
    }
    return resolvedTarget;
  }
  throw new MessagingBuildApplierError(`Unsupported messaging render target ${target}.`);
}

function enabledAgentRender(plan: MessagingBuildPlan): MessagingRenderEntry[] {
  const active = new Set(activeChannels(plan));
  return plan.agentRender.filter(
    (render) => render.agent === plan.agent && active.has(render.channelId),
  );
}

function enabledBuildStepsForPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingHookPhase,
): MessagingBuildStep[] {
  if (!plan) return [];
  return enabledBuildSteps(plan).filter((step) => buildStepMatchesPhase(plan, step, phase));
}

function enabledBuildSteps(plan: MessagingBuildPlan): MessagingBuildStep[] {
  const active = new Set(activeChannels(plan));
  return plan.buildSteps.filter((step) => active.has(step.channelId));
}

function buildStepMatchesPhase(
  plan: MessagingBuildPlan,
  step: MessagingBuildStep,
  phase: MessagingHookPhase,
): boolean {
  const hookPhase = step.hookId ? findHookPhase(plan, step.channelId, step.hookId) : undefined;
  if (hookPhase) return hookPhase === phase;

  // Older compiled plans did not carry hook phase on build steps. Fall back by
  // output kind so package installs remain agent-install and files remain
  // post-agent-install without re-running channel-specific handlers.
  if (phase === "agent-install") return step.kind === "package-install";
  if (phase === "post-agent-install") return step.kind === "build-file";
  return false;
}

function findHookPhase(
  plan: MessagingBuildPlan,
  channelId: string,
  hookId: string,
): string | undefined {
  const channel = plan.channels.find((candidate) => candidate.channelId === channelId);
  return channel?.hooks?.find((hook) => hook.id === hookId)?.phase;
}

function applyBuildFileOutputToLocalAgentRoot(
  agent: MessagingAgentId,
  file: BuildFileOutput,
  options: { readonly homeDir?: string } = {},
): string {
  const root =
    agent === "hermes"
      ? join(options.homeDir ?? homedir(), ".hermes")
      : join(options.homeDir ?? homedir(), ".openclaw");
  const relativePath = normalizeBuildFilePath(file.path);
  const target = resolve(root, relativePath);
  const normalizedRoot = resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${file.path} must stay inside ${root}`,
    );
  }

  const contents =
    file.merge !== undefined
      ? mergeBuildFileContent(readTextIfExists(target), file.merge, target)
      : serializeBuildFileContent(file.content);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  if (file.mode) chmodSync(target, parseBuildFileMode(file.path, file.mode));
  return target;
}

function mergeBuildFileContent(
  existing: string | undefined,
  patch: MessagingSerializableValue,
  target: string,
): string {
  if (!isObject(patch)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file merge for ${target} must be an object.`,
    );
  }
  const root = parseJsonObject(existing, target);
  mergeJsonObjects(root, patch as JsonObject);
  return `${JSON.stringify(root, null, 2)}\n`;
}

function parseJsonObject(existing: string | undefined, target: string): JsonObject {
  if (!existing || existing.trim().length === 0) return {};
  const parsed = JSON.parse(existing) as unknown;
  if (!isObject(parsed)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file target ${target} must contain an object.`,
    );
  }
  return parsed as JsonObject;
}

function readTextIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function readBuildFileOutput(value: MessagingSerializableValue): BuildFileOutput {
  if (!isObject(value)) {
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  }
  const file = value as JsonObject;
  if (typeof file.path !== "string" || file.path.trim().length === 0) {
    throw new MessagingBuildApplierError("Messaging build-file output must include a path");
  }
  if (file.content === undefined && file.merge === undefined) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${file.path} must include content or merge`,
    );
  }
  if (file.mode !== undefined && typeof file.mode !== "string") {
    throw new MessagingBuildApplierError(`Messaging build-file ${file.path} mode must be a string`);
  }
  return file as BuildFileOutput;
}

function normalizeBuildFilePath(pathValue: string): string {
  if (pathValue.startsWith("/") || pathValue.includes("\\") || /[\0-\x1F\x7F]/.test(pathValue)) {
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${pathValue} must be a safe relative path`,
    );
  }
  const segments = pathValue.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new MessagingBuildApplierError(
      `Messaging build-file path ${pathValue} must not traverse directories`,
    );
  }
  return pathValue;
}

function serializeBuildFileContent(value: MessagingSerializableValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.endsWith("\n") ? value : `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseBuildFileMode(pathValue: string, mode: string): number {
  if (!/^[0-7]{3,4}$/.test(mode) || (mode.length === 4 && mode[0] !== "0")) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must be an octal file mode`,
    );
  }
  const parsed = Number.parseInt(mode, 8);
  if ((parsed & 0o022) !== 0) {
    throw new MessagingBuildApplierError(
      `Messaging build-file ${pathValue} mode must not be group/world writable`,
    );
  }
  return parsed;
}

function readOpenClawPackageInstall(
  value: MessagingSerializableValue,
  outputId: string,
): {
  readonly manager: "openclaw-plugin";
  readonly spec: string;
  readonly pin?: boolean;
} {
  if (!isObject(value)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must be an object`,
    );
  }
  const install = value as JsonObject;
  if (install.manager !== "openclaw-plugin") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must use manager 'openclaw-plugin'`,
    );
  }
  if (typeof install.spec !== "string" || install.spec.trim().length === 0) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must include a package spec`,
    );
  }
  if (install.pin !== undefined && typeof install.pin !== "boolean") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} pin must be boolean`,
    );
  }
  return install as {
    readonly manager: "openclaw-plugin";
    readonly spec: string;
    readonly pin?: boolean;
  };
}

function resolveOpenClawPackageSpec(spec: string, env: Env): string {
  const version = (env.OPENCLAW_VERSION || "").trim();
  const resolved = spec.replaceAll("{{openclaw.version}}", () => {
    if (!version) {
      throw new MessagingBuildApplierError(
        "OPENCLAW_VERSION is required when OpenClaw package install hooks are active",
      );
    }
    return version;
  });
  if (/\{\{\s*[^}]+\s*\}\}/.test(resolved)) {
    throw new MessagingBuildApplierError(`Unresolved package-install template in ${spec}`);
  }
  return resolved;
}

function assertAllowedOpenClawPackageSpec(channelId: string, resolvedSpec: string, env: Env): void {
  const allowedSpecs = allowedOpenClawPackageSpecsForChannel(channelId, env);
  if (!allowedSpecs.includes(resolvedSpec)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install spec for ${channelId} is not allowed: ${resolvedSpec}`,
    );
  }
}

function allowedOpenClawPackageSpecsForChannel(channelId: string, env: Env): readonly string[] {
  const versionedPackage = OPENCLAW_VERSIONED_MESSAGING_PLUGIN_PACKAGES[channelId];
  if (versionedPackage) {
    return ["npm:" + versionedPackage + "@" + requiredOpenClawVersion(env)];
  }

  const fixedSpec = OPENCLAW_FIXED_MESSAGING_PLUGIN_INSTALL_SPECS[channelId];
  return fixedSpec ? [fixedSpec] : [];
}

function requiredOpenClawVersion(env: Env): string {
  const version = (env.OPENCLAW_VERSION || "").trim();
  if (!version) {
    throw new MessagingBuildApplierError(
      "OPENCLAW_VERSION is required when OpenClaw package install hooks are active",
    );
  }
  return version;
}

function runCommand(args: readonly string[], env: Env): void {
  console.log(`+ ${args.join(" ")}`);
  const result = spawnSync(args[0] as string, args.slice(1), {
    env: env as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new MessagingBuildApplierError(
      `${args[0]} exited with status ${String(result.status ?? "unknown")}`,
    );
  }
}

type CredentialPlaceholderRule = {
  readonly envKey: string;
  readonly placeholder: string;
};

function credentialPlaceholderRules(
  plan: MessagingBuildPlan | null | undefined,
): CredentialPlaceholderRule[] {
  if (!plan) return [];
  const active = new Set(activeChannels(plan));
  return plan.credentialBindings.flatMap((binding) => {
    if (!active.has(binding.channelId)) return [];
    if (typeof binding.providerEnvKey !== "string" || typeof binding.placeholder !== "string") {
      return [];
    }
    return [{ envKey: binding.providerEnvKey, placeholder: binding.placeholder }];
  });
}

function preserveCredentialPlaceholders(
  desired: MessagingSerializableValue,
  existing: unknown,
  rules: readonly CredentialPlaceholderRule[],
): MessagingSerializableValue {
  if (typeof desired === "string") {
    const rule = rules.find((candidate) => candidate.placeholder === desired);
    if (
      rule &&
      typeof existing === "string" &&
      isProviderPlaceholderForEnvKey(existing, rule.envKey)
    ) {
      return existing;
    }
    return desired;
  }
  if (Array.isArray(desired)) {
    return desired.map((entry, index) =>
      preserveCredentialPlaceholders(
        entry,
        Array.isArray(existing) ? existing[index] : undefined,
        rules,
      ),
    );
  }
  if (isObject(desired)) {
    const existingObject = isObject(existing) ? existing : {};
    return Object.fromEntries(
      Object.entries(desired).map(([key, value]) => [
        key,
        preserveCredentialPlaceholders(value, existingObject[key], rules),
      ]),
    );
  }
  return desired;
}

function getJsonPath(root: JsonObject, pathValue: string): unknown {
  let cursor: unknown = root;
  for (const segment of pathValue.split(".").filter(Boolean)) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function isProviderPlaceholderForEnvKey(value: string, envKey: string): boolean {
  const openShellPrefix = "openshell:resolve:env:";
  if (value.startsWith(openShellPrefix)) {
    return placeholderSuffixMatchesEnvKey(value.slice(openShellPrefix.length), envKey);
  }
  const aliasMatch = value.match(/^[A-Za-z0-9]+-OPENSHELL-RESOLVE-ENV-(.+)$/);
  return aliasMatch ? placeholderSuffixMatchesEnvKey(aliasMatch[1] as string, envKey) : false;
}

function placeholderSuffixMatchesEnvKey(suffix: string, envKey: string): boolean {
  if (suffix === envKey) return true;
  const revisionMatch = suffix.match(/^v[0-9]+_(.+)$/);
  return revisionMatch?.[1] === envKey;
}

function setJsonPath(root: JsonObject, pathValue: string, value: MessagingSerializableValue): void {
  const segments = pathValue.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new MessagingBuildApplierError("Messaging render path must not be empty");
  }
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    assertSafeObjectKey(segment, "Messaging render path");
    if (!isObject(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment] as JsonObject;
  }
  const finalSegment = segments[segments.length - 1] as string;
  assertSafeObjectKey(finalSegment, "Messaging render path");
  if (isObject(cursor[finalSegment]) && isObject(value)) {
    mergeJsonObjects(cursor[finalSegment] as JsonObject, value as JsonObject);
    return;
  }
  cursor[finalSegment] = value;
}

function mergeJsonObjects(target: JsonObject, patch: JsonObject): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new MessagingBuildApplierError(
        "Messaging object merge rejected unsafe object key " + key,
      );
    }
    const existing = target[key];
    if (isObject(existing) && isObject(value)) {
      mergeJsonObjects(existing as JsonObject, value as JsonObject);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      setMergedObjectValue(target, key, [...new Set([...existing, ...value])]);
    } else {
      setMergedObjectValue(target, key, value);
    }
  }
}

function setMergedObjectValue(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function mergeEnvLines(existingLines: string[], desiredLines: readonly string[]): void {
  const desired = new Map<string, string>();
  const rawDesiredLines: string[] = [];
  for (const line of desiredLines) {
    const key = readEnvLineKey(line);
    if (key) {
      desired.set(key, line);
    } else {
      rawDesiredLines.push(line);
    }
  }

  const written = new Set<string>();
  for (const [index, line] of existingLines.entries()) {
    const key = readEnvLineKey(line);
    if (!key || !desired.has(key)) continue;
    existingLines[index] = desired.get(key) as string;
    written.add(key);
  }

  for (const [key, line] of desired) {
    if (!written.has(key)) existingLines.push(line);
  }
  existingLines.push(...rawDesiredLines);
}

type GeneratedYamlLine = {
  readonly indent: number;
  readonly text: string;
  readonly lineNumber: number;
};

function parseGeneratedYamlObject(existing: string | undefined, target: string): JsonObject {
  if (!existing || existing.trim().length === 0) return {};
  const lines = existing
    .split(/\r?\n/)
    .map((line, index): GeneratedYamlLine | null => {
      if (isIgnorableGeneratedYamlLine(line)) return null;
      const indent = line.match(/^ */)?.[0].length ?? 0;
      return { indent, text: line.slice(indent), lineNumber: index + 1 };
    })
    .filter((line): line is GeneratedYamlLine => line !== null);
  if (lines.length === 0) return {};
  const [parsed, nextIndex] = parseGeneratedYamlBlock(lines, 0, lines[0]?.indent ?? 0, target);
  if (nextIndex !== lines.length || !isObject(parsed)) {
    throw new MessagingBuildApplierError(`Messaging YAML target ${target} must contain an object.`);
  }
  return parsed as JsonObject;
}

function isIgnorableGeneratedYamlLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...";
}

function parseGeneratedYamlBlock(
  lines: readonly GeneratedYamlLine[],
  startIndex: number,
  indent: number,
  target: string,
): [MessagingSerializableValue, number] {
  const first = lines[startIndex];
  if (!first || first.indent < indent) return [{}, startIndex];
  if (first.indent !== indent) {
    throw new MessagingBuildApplierError(
      `Messaging YAML target ${target} has unsupported indentation at line ${first.lineNumber}.`,
    );
  }
  if (first.text.startsWith("-")) {
    return parseGeneratedYamlArray(lines, startIndex, indent, target);
  }
  return parseGeneratedYamlMap(lines, startIndex, indent, target);
}

function parseGeneratedYamlMap(
  lines: readonly GeneratedYamlLine[],
  startIndex: number,
  indent: number,
  target: string,
): [JsonObject, number] {
  const parsed: JsonObject = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] as GeneratedYamlLine;
    if (line.indent < indent) break;
    if (line.indent !== indent) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported indentation at line ${line.lineNumber}.`,
      );
    }
    if (line.text.startsWith("-")) break;
    const colonIndex = line.text.indexOf(":");
    if (colonIndex <= 0) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported mapping syntax at line ${line.lineNumber}.`,
      );
    }
    const key = line.text.slice(0, colonIndex).trim();
    assertSafeObjectKey(key, "Messaging YAML render path");
    const rest = line.text.slice(colonIndex + 1).trim();
    if (rest.length > 0) {
      parsed[key] = parseGeneratedYamlScalar(rest, target, line.lineNumber);
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (!next || next.indent < indent || (next.indent === indent && !next.text.startsWith("-"))) {
      parsed[key] = {};
      index += 1;
      continue;
    }
    const childIndent = next.text.startsWith("-") && next.indent === indent ? indent : indent + 2;
    const [value, nextIndex] = parseGeneratedYamlBlock(lines, index + 1, childIndent, target);
    parsed[key] = value;
    index = nextIndex;
  }
  return [parsed, index];
}

function parseGeneratedYamlArray(
  lines: readonly GeneratedYamlLine[],
  startIndex: number,
  indent: number,
  target: string,
): [MessagingSerializableValue[], number] {
  const parsed: MessagingSerializableValue[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] as GeneratedYamlLine;
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.text.startsWith("-")) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has unsupported array syntax at line ${line.lineNumber}.`,
      );
    }
    const rest = line.text.slice(1).trim();
    if (rest.length > 0) {
      parsed.push(parseGeneratedYamlScalar(rest, target, line.lineNumber));
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (!next || next.indent <= indent) {
      parsed.push({});
      index += 1;
      continue;
    }
    const [value, nextIndex] = parseGeneratedYamlBlock(lines, index + 1, indent + 2, target);
    parsed.push(value);
    index = nextIndex;
  }
  return [parsed, index];
}

function parseGeneratedYamlScalar(
  value: string,
  target: string,
  lineNumber: number,
): MessagingSerializableValue {
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as MessagingSerializableValue;
    } catch (error) {
      throw new MessagingBuildApplierError(
        `Messaging YAML target ${target} has invalid quoted scalar at line ${lineNumber}: ${formatError(error)}`,
      );
    }
  }
  return value;
}

function serializeGeneratedYamlObject(value: JsonObject): string {
  return serializeGeneratedYamlValue(value);
}

function serializeGeneratedYamlValue(
  value: MessagingSerializableValue,
  indent: number = 0,
): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    let out = "";
    for (const item of value) {
      if (isObject(item)) {
        out += `${pad}-\n`;
        out += serializeGeneratedYamlValue(item as MessagingSerializableValue, indent + 1);
      } else if (Array.isArray(item)) {
        out += `${pad}-\n`;
        out += serializeGeneratedYamlValue(item, indent + 1);
      } else {
        out += `${pad}- ${formatGeneratedYamlScalar(item)}\n`;
      }
    }
    return out;
  }
  if (isObject(value)) {
    let out = "";
    for (const [key, item] of Object.entries(value)) {
      assertSafeObjectKey(key, "Messaging YAML object");
      if (Array.isArray(item)) {
        out +=
          item.length === 0
            ? `${pad}${key}: []\n`
            : `${pad}${key}:\n${serializeGeneratedYamlValue(item, indent + 1)}`;
      } else if (isObject(item)) {
        const entries = Object.entries(item);
        out +=
          entries.length === 0
            ? `${pad}${key}: {}\n`
            : `${pad}${key}:\n${serializeGeneratedYamlValue(item as MessagingSerializableValue, indent + 1)}`;
      } else {
        out += `${pad}${key}: ${formatGeneratedYamlScalar(item as MessagingSerializableValue)}\n`;
      }
    }
    return out;
  }
  return `${pad}${formatGeneratedYamlScalar(value)}\n`;
}

function formatGeneratedYamlScalar(value: MessagingSerializableValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return JSON.stringify(value);
  if (value === "") return JSON.stringify(value);
  if (/[:{}\[\],&*?|>!%@`#'\"]/.test(value) || value.includes("\n") || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

function readEnvLineKey(line: string): string | null {
  const index = line.indexOf("=");
  if (index <= 0) return null;
  const key = line.slice(0, index).trim();
  return key.length > 0 ? key : null;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value || value.trim() === "") return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function requiredSerializableValue(value: unknown, label: string): MessagingSerializableValue {
  if (value === undefined) {
    throw new MessagingBuildApplierError(`Messaging ${label} is missing`);
  }
  return value as MessagingSerializableValue;
}

function assertSafeObjectKey(key: string, context: string): void {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new MessagingBuildApplierError(`${context} rejected unsafe object key ${key}`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type MessagingBuildPhase = "agent-install" | "post-agent-install";

export function applyMessagingBuildPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env = process.env,
): readonly string[] {
  if (phase === "agent-install") {
    installMessagingPackages(plan, env);
    return [];
  }
  const applyPostAgentInstallOutputs = (): readonly string[] => [
    ...applyMessagingAgentRenderToLocalFiles(plan),
    ...applyPostAgentInstallBuildFilesToLocalFiles(plan),
  ];
  const appliedTargets = applyPostAgentInstallOutputs();
  if (plan?.agent === "openclaw") {
    runOpenClawMessagingDoctor(plan, env);
    return uniqueStrings([...appliedTargets, ...applyPostAgentInstallOutputs()]);
  }
  return uniqueStrings(appliedTargets);
}

export function installMessagingPackages(plan: MessagingBuildPlan | null, env: Env): void {
  if (!plan) return;
  if (plan.agent === "openclaw") {
    installOpenClawMessagingPlugins(plan, env);
    return;
  }

  const packageSteps = enabledBuildStepsForPhase(plan, "agent-install").filter(
    (step) => step.kind === "package-install",
  );
  if (packageSteps.length > 0) {
    throw new MessagingBuildApplierError(
      `Messaging package-install is not supported for ${plan.agent}`,
    );
  }
}

export function describeMessagingBuildPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env,
): BuildCommandResult & {
  readonly agent: MessagingAgentId | "unknown";
  readonly phase: MessagingBuildPhase;
} {
  return {
    agent: plan?.agent ?? "unknown",
    phase,
    channels: activeChannels(plan),
    doctorEnv: plan?.agent === "openclaw" ? openClawDoctorEnvOverrides(plan, env) : {},
    installSpecs:
      plan?.agent === "openclaw" ? collectOpenClawMessagingPluginInstallSpecs(plan, env) : [],
    openclawVersion: env.OPENCLAW_VERSION || "",
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const { agent, phase, dryRun } = parseMessagingBuildArgs(argv);
  const plan = readMessagingBuildPlanFromEnv(process.env, agent);
  if (dryRun) {
    console.log(JSON.stringify(describeMessagingBuildPhase(plan, phase, process.env), null, 2));
    return;
  }
  applyMessagingBuildPhase(plan, phase, process.env);
}

function parseMessagingBuildArgs(argv: readonly string[]): {
  readonly agent: MessagingAgentId;
  readonly phase: MessagingBuildPhase;
  readonly dryRun: boolean;
} {
  let agent: MessagingAgentId | undefined;
  let phase: MessagingBuildPhase | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--agent") {
      agent = readAgentArg(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      agent = readAgentArg(arg.slice("--agent=".length));
      continue;
    }
    if (arg === "--phase") {
      phase = readPhaseArg(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--phase=")) {
      phase = readPhaseArg(arg.slice("--phase=".length));
      continue;
    }
    if (!arg.startsWith("-") && !phase) {
      phase = readPhaseArg(arg);
      continue;
    }
    throw new MessagingBuildApplierError(`Unknown messaging build applier argument: ${arg}`);
  }

  return {
    agent: agent ?? "openclaw",
    phase: phase ?? "post-agent-install",
    dryRun,
  };
}

function readAgentArg(value: string | undefined): MessagingAgentId {
  if (value === "openclaw" || value === "hermes") return value;
  throw new MessagingBuildApplierError("--agent must be 'openclaw' or 'hermes'");
}

function readPhaseArg(value: string | undefined): MessagingBuildPhase {
  if (value === "agent-install" || value === "post-agent-install") return value;
  throw new MessagingBuildApplierError("--phase must be 'agent-install' or 'post-agent-install'");
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
