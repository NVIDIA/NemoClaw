#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { discordManifest } from "../../channels/discord/manifest.ts";
import { slackManifest } from "../../channels/slack/manifest.ts";
import { teamsManifest } from "../../channels/teams/manifest.ts";
import { telegramManifest } from "../../channels/telegram/manifest.ts";
import { wechatManifest } from "../../channels/wechat/manifest.ts";
import { whatsappManifest } from "../../channels/whatsapp/manifest.ts";
import type { ChannelManifest } from "../../manifest/types.ts";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, any>;
type MessagingAgentId = "openclaw" | "hermes";
type MessagingHookPhase = "agent-install" | "post-agent-install";
type MessagingRuntimeSetupKey = "nodePreloads" | "envAliases" | "secretScans";
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
  readonly workflow?: string;
  readonly channels: readonly MessagingPlanChannel[];
  readonly disabledChannels?: readonly string[];
  readonly credentialBindings: readonly MessagingCredentialBinding[];
  readonly agentRender: readonly MessagingRenderEntry[];
  readonly buildSteps: readonly MessagingBuildStep[];
  readonly runtimeSetup?: Partial<Record<MessagingRuntimeSetupKey, readonly JsonObject[]>>;
};

export type BuildFileOutput = {
  readonly path: string;
  readonly mode?: string;
  readonly content?: MessagingSerializableValue;
  readonly merge?: MessagingSerializableValue;
};

export type BuildCommandResult = {
  readonly channels: readonly string[];
  readonly runtimePlanPath: string;
  readonly doctorEnv: Record<string, string>;
  readonly installSpecs: readonly string[];
  readonly hermesUvPackages: readonly string[];
  readonly openclawVersion: string;
};

type OpenClawPluginInstall = {
  readonly spec: string;
  readonly npmPackageSpec?: string;
  readonly integrity?: string;
  readonly tarballUrl?: string;
  readonly pin: boolean;
};

// Every trusted messaging plugin binds exact package identity, registry SRI,
// registry tarball URL, and packed-byte SRI before local archive installation.
// Keep these checks together when #5896 consolidates the archive installers.
export const OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY = Object.freeze({
  schemaVersion: 1,
  packageIdentity: "exact-npm-package-spec",
  registryIntegrityField: "dist.integrity",
  packedArchiveIntegrity: "must-match-committed-sri",
  registryTarballField: "dist.tarball",
  registryTarballUrl: "must-match-committed-url",
} as const);

const NPM_METADATA_MAX_BUFFER = 16 * 1024 * 1024;

type HermesUvPackageInstall = {
  readonly spec: string;
};

const TRUSTED_CHANNEL_MANIFESTS: readonly ChannelManifest[] = [
  telegramManifest,
  discordManifest,
  wechatManifest,
  slackManifest,
  whatsappManifest,
  teamsManifest,
] as const;

function isPinnedHermesUvPackageSpec(spec: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9][A-Za-z0-9_.-]*(?:,[A-Za-z0-9][A-Za-z0-9_.-]*)*\])?==[A-Za-z0-9][A-Za-z0-9_.!+~-]*$/.test(
    spec,
  );
}

export class MessagingBuildApplierError extends Error {}

export const DEFAULT_MESSAGING_RUNTIME_PLAN_PATH =
  "/usr/local/share/nemoclaw/messaging-runtime-plan.json";

export function reviewedOpenClawPluginIntegrityByPackageSpec(
  env: Env = process.env,
  manifests: readonly ChannelManifest[] = TRUSTED_CHANNEL_MANIFESTS,
): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.agent !== "openclaw" || packageSpec.manager !== "openclaw-plugin") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      const integrity =
        packageSpec.integrity ?? packageSpec.integrityByVersion?.[npmPackage.version];
      if (integrity) entries.push([npmPackage.packageSpec, integrity]);
    }
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))),
  );
}

export function reviewedOpenClawPluginTarballUrlByPackageSpec(
  env: Env = process.env,
  manifests: readonly ChannelManifest[] = TRUSTED_CHANNEL_MANIFESTS,
): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.agent !== "openclaw" || packageSpec.manager !== "openclaw-plugin") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      const npmPackage = requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      const tarballUrl =
        packageSpec.tarballUrl ?? packageSpec.tarballUrlByVersion?.[npmPackage.version];
      if (tarballUrl) entries.push([npmPackage.packageSpec, tarballUrl]);
    }
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))),
  );
}

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

export function messagingRuntimePlanPath(env: Env = process.env): string {
  const configured = env.NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH?.trim();
  return configured || DEFAULT_MESSAGING_RUNTIME_PLAN_PATH;
}

export function buildMessagingRuntimePlanArtifact(
  plan: MessagingBuildPlan | null,
): JsonObject | null {
  if (!plan) return null;
  return {
    schemaVersion: 1,
    sandboxName: plan.sandboxName,
    agent: plan.agent,
    ...(typeof plan.workflow === "string" && plan.workflow ? { workflow: plan.workflow } : {}),
    channels: sanitizeRuntimeArtifactChannels(plan.channels),
    disabledChannels: sanitizeStringArray(plan.disabledChannels ?? []),
    credentialBindings: sanitizeRuntimeArtifactCredentialBindings(plan.credentialBindings),
    runtimeSetup: sanitizeRuntimeSetup(plan.runtimeSetup),
  };
}

export function writeMessagingRuntimePlanArtifact(
  plan: MessagingBuildPlan | null,
  targetPath: string,
): string | null {
  const artifact = buildMessagingRuntimePlanArtifact(plan);
  if (!artifact) return null;
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(artifact, null, 2)}\n`);
  chmodSync(targetPath, 0o644);
  return targetPath;
}

function sanitizeRuntimeArtifactChannels(
  channels: readonly MessagingPlanChannel[],
): readonly JsonObject[] {
  return channels.flatMap((channel): JsonObject[] => {
    const channelId = sanitizeOptionalString(channel.channelId);
    if (!channelId) return [];
    return [
      {
        channelId,
        active: channel.active === true,
        disabled: channel.disabled === true,
      },
    ];
  });
}

function sanitizeRuntimeArtifactCredentialBindings(
  bindings: readonly MessagingCredentialBinding[],
): readonly JsonObject[] {
  return bindings.flatMap((binding): JsonObject[] => {
    const channelId = sanitizeOptionalString(binding.channelId);
    const providerEnvKey = sanitizeOptionalString(binding.providerEnvKey);
    if (!channelId || !providerEnvKey) return [];
    return [{ channelId, providerEnvKey }];
  });
}

function sanitizeRuntimeSetup(
  setup: MessagingBuildPlan["runtimeSetup"] | undefined,
): Record<MessagingRuntimeSetupKey, readonly JsonObject[]> {
  return {
    nodePreloads: sanitizeRuntimeSetupEntries(setup?.nodePreloads, [
      "channelId",
      "source",
      "target",
      "injectInto",
      "optional",
      "installMessage",
      "installedMessage",
    ]),
    envAliases: sanitizeRuntimeSetupEntries(setup?.envAliases, [
      "channelId",
      "envKey",
      "match",
      "value",
      "message",
    ]),
    secretScans: sanitizeRuntimeSetupEntries(setup?.secretScans, [
      "channelId",
      "path",
      "pattern",
      "message",
      "exitCode",
    ]),
  };
}

function sanitizeRuntimeSetupEntries(
  entries: readonly JsonObject[] | undefined,
  allowedKeys: readonly string[],
): readonly JsonObject[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    if (!isObject(entry)) {
      throw new MessagingBuildApplierError(
        `Messaging runtime setup entry ${index} must be an object`,
      );
    }
    const channelId = sanitizeOptionalString(entry.channelId);
    if (!channelId) {
      throw new MessagingBuildApplierError(
        `Messaging runtime setup entry ${index} must include channelId`,
      );
    }
    const sanitized: JsonObject = { channelId };
    for (const key of allowedKeys) {
      if (key === "channelId" || entry[key] === undefined) continue;
      sanitized[key] = cloneRuntimeArtifactValue(entry[key], `runtime setup entry ${index}.${key}`);
    }
    return sanitized;
  });
}

function cloneRuntimeArtifactValue(value: unknown, label: string): MessagingSerializableValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      cloneRuntimeArtifactValue(entry, `${label}[${String(index)}]`),
    );
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        assertSafeObjectKey(key, label);
        return [key, cloneRuntimeArtifactValue(entry, `${label}.${key}`)];
      }),
    );
  }
  throw new MessagingBuildApplierError(`${label} must be JSON-serializable`);
}

function sanitizeStringArray(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = sanitizeOptionalString(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function sanitizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function collectOpenClawMessagingPluginInstallSpecs(
  plan: MessagingBuildPlan | null,
  env: Env,
): string[] {
  return collectOpenClawMessagingPluginInstalls(plan, env).map((install) => install.spec);
}

export function collectHermesMessagingUvPackages(plan: MessagingBuildPlan | null): string[] {
  if (plan?.agent !== "hermes") return [];
  return collectHermesMessagingUvPackageInstalls(plan).map((install) => install.spec);
}

function collectOpenClawMessagingPluginInstalls(
  plan: MessagingBuildPlan | null,
  env: Env,
): OpenClawPluginInstall[] {
  const installs: OpenClawPluginInstall[] = [];
  const seen = new Set<string>();
  const trustedManifests = trustedChannelManifestsForActivePlan(plan);
  const trustedSpecs = trustedOpenClawPluginSpecsForManifests(trustedManifests, env);
  const reviewedIntegrity = reviewedOpenClawPluginIntegrityByPackageSpec(env, trustedManifests);
  const reviewedTarballUrls = reviewedOpenClawPluginTarballUrlByPackageSpec(env, trustedManifests);
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
    const npmPackage = parseNpmPackageSpec(resolvedSpec);
    if (npmPackage && !trustedSpecs.has(resolvedSpec)) {
      throw new MessagingBuildApplierError(
        `Messaging package-install output ${step.outputId} is not declared by a trusted built-in manifest for active OpenClaw channels: ${resolvedSpec}`,
      );
    }
    const integrity = npmPackage ? reviewedIntegrity[npmPackage.packageSpec] : undefined;
    const tarballUrl = npmPackage ? reviewedTarballUrls[npmPackage.packageSpec] : undefined;
    const resolvedInstall: OpenClawPluginInstall = {
      spec: resolvedSpec,
      ...(npmPackage ? { npmPackageSpec: npmPackage.packageSpec } : {}),
      ...(integrity ? { integrity } : {}),
      ...(tarballUrl ? { tarballUrl } : {}),
      pin: integrity !== undefined,
    };
    const key = JSON.stringify(resolvedInstall);
    if (seen.has(key)) continue;
    seen.add(key);
    installs.push(resolvedInstall);
  }
  return installs;
}

/**
 * Security boundary: NEMOCLAW_MESSAGING_PLAN_B64 is a derived build artifact,
 * not authority to choose root-time OpenClaw plugins. Invalid state: a serialized
 * OpenClaw plan names a reviewed npm plugin for a channel that is not active.
 * Source fix: update the selected channel's trusted manifest, not the serialized
 * plan/env. Remove this recheck only once package installs are no longer
 * serialized or plans are signed and attested at the Docker build boundary.
 */
function trustedChannelManifestsForActivePlan(plan: MessagingBuildPlan | null): ChannelManifest[] {
  const active = new Set(activeChannels(plan));
  return TRUSTED_CHANNEL_MANIFESTS.filter((manifest) => active.has(manifest.id));
}

function trustedOpenClawPluginSpecsForManifests(
  manifests: readonly ChannelManifest[],
  env: Env,
): Set<string> {
  const specs = new Set<string>();
  for (const manifest of manifests) {
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.agent !== "openclaw" || packageSpec.manager !== "openclaw-plugin") continue;
      const resolvedSpec = resolveOpenClawPackageSpec(packageSpec.spec, env);
      requireExactNpmPackageSpec(resolvedSpec, manifest.id);
      specs.add(resolvedSpec);
    }
  }
  return specs;
}

function collectHermesMessagingUvPackageInstalls(
  plan: MessagingBuildPlan | null,
): HermesUvPackageInstall[] {
  const installs: HermesUvPackageInstall[] = [];
  const seen = new Set<string>();
  const trustedSpecs = trustedHermesUvPackageSpecsForPlan(plan);
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
    const install = readHermesUvPipPackageInstall(step.value, step.outputId);
    if (!trustedSpecs.has(install.spec)) {
      throw new MessagingBuildApplierError(
        `Messaging package-install output ${step.outputId} is not declared by a trusted built-in manifest for active Hermes channels: ${install.spec}`,
      );
    }
    if (seen.has(install.spec)) continue;
    seen.add(install.spec);
    installs.push(install);
  }
  return installs;
}

/**
 * Security boundary: NEMOCLAW_MESSAGING_PLAN_B64 is a derived build artifact,
 * not authority to choose root-time Hermes packages. Invalid state: a serialized
 * plan contains a hermes-uv-pip package spec absent from the trusted built-in
 * manifest for a selected active channel. Source fix: update the channel
 * manifest's agentPackages, not the serialized plan/env. Remove this recheck
 * only once package installs are no longer serialized or plans are signed and
 * attested at the Docker build boundary.
 */
function trustedHermesUvPackageSpecsForPlan(plan: MessagingBuildPlan | null): Set<string> {
  const active = new Set(activeChannels(plan));
  const specs = new Set<string>();
  for (const manifest of TRUSTED_CHANNEL_MANIFESTS) {
    if (!active.has(manifest.id)) continue;
    for (const packageSpec of manifest.agentPackages ?? []) {
      if (packageSpec.agent !== "hermes" || packageSpec.manager !== "hermes-uv-pip") continue;
      if (!isPinnedHermesUvPackageSpec(packageSpec.spec)) {
        throw new MessagingBuildApplierError(
          `Trusted manifest ${manifest.id} declares an unsafe Hermes Python package spec: ${packageSpec.spec}`,
        );
      }
      specs.add(packageSpec.spec);
    }
  }
  return specs;
}

export function openClawDoctorEnvOverrides(
  plan: MessagingBuildPlan | null,
  env: Env = process.env,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (plan) {
    const active = new Set(activeChannels(plan));
    for (const binding of plan.credentialBindings) {
      if (!active.has(binding.channelId)) continue;
      if (typeof binding.providerEnvKey === "string" && typeof binding.placeholder === "string") {
        overrides[binding.providerEnvKey] = binding.placeholder;
      }
    }
  }
  if (isTruthyEnv(env.NEMOCLAW_WEB_SEARCH_ENABLED)) {
    const provider = (env.NEMOCLAW_WEB_SEARCH_PROVIDER || "brave").trim();
    if (provider === "brave") {
      overrides.BRAVE_API_KEY = "openshell:resolve:env:BRAVE_API_KEY";
    } else if (provider === "tavily") {
      overrides.TAVILY_API_KEY = "openshell:resolve:env:TAVILY_API_KEY";
    } else {
      throw new MessagingBuildApplierError(
        `Unsupported NEMOCLAW_WEB_SEARCH_PROVIDER: ${provider || "<empty>"}`,
      );
    }
  }
  return overrides;
}

export function installOpenClawMessagingPlugins(plan: MessagingBuildPlan | null, env: Env): void {
  for (const install of collectOpenClawMessagingPluginInstalls(plan, env)) {
    const packed = packVerifiedOpenClawPluginArchive(install, env);
    try {
      runCommand(
        ["openclaw", "plugins", "install", packed.archivePath, ...(install.pin ? ["--pin"] : [])],
        {
          ...env,
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          npm_config_ignore_scripts: "true",
        },
      );
    } finally {
      rmSync(packed.rootDir, { recursive: true, force: true });
    }
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
  const home = options.homeDir ?? homedir();
  const root = agent === "hermes" ? join(home, ".hermes") : join(home, ".openclaw");
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
  readonly integrity?: string;
  readonly integrityByVersion?: Readonly<Record<string, string>>;
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
  if (install.integrity !== undefined && typeof install.integrity !== "string") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} integrity must be a string`,
    );
  }
  if (install.integrityByVersion !== undefined && !isStringRecord(install.integrityByVersion)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} integrityByVersion must map versions to strings`,
    );
  }
  return install as {
    readonly manager: "openclaw-plugin";
    readonly spec: string;
    readonly integrity?: string;
    readonly integrityByVersion?: Readonly<Record<string, string>>;
    readonly pin?: boolean;
  };
}

function readHermesUvPipPackageInstall(
  value: MessagingSerializableValue,
  outputId: string,
): HermesUvPackageInstall {
  if (!isObject(value)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must be an object`,
    );
  }
  const install = value as JsonObject;
  if (install.manager !== "hermes-uv-pip") {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must use manager 'hermes-uv-pip'`,
    );
  }
  if (typeof install.spec !== "string" || install.spec.trim().length === 0) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must include a Hermes Python package spec`,
    );
  }
  const spec = install.spec.trim();
  if (!isPinnedHermesUvPackageSpec(spec)) {
    throw new MessagingBuildApplierError(
      `Messaging package-install output ${outputId} must use a safe exact-pinned Hermes Python package spec`,
    );
  }
  return { spec };
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

function parseNpmPackageSpec(
  spec: string,
): { readonly packageSpec: string; readonly version?: string } | null {
  if (!spec.startsWith("npm:")) return null;
  const packageSpec = spec.slice("npm:".length);
  const versionAt = packageSpec.startsWith("@")
    ? packageSpec.indexOf("@", 1)
    : packageSpec.lastIndexOf("@");
  if (versionAt <= 0 || versionAt === packageSpec.length - 1) return { packageSpec };
  return { packageSpec, version: packageSpec.slice(versionAt + 1) };
}

const EXACT_NPM_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function requireExactNpmPackageSpec(
  spec: string,
  manifestId: string,
): { readonly packageSpec: string; readonly version: string } {
  const parsed = parseNpmPackageSpec(spec);
  if (!parsed) {
    throw new MessagingBuildApplierError(
      `Trusted manifest ${manifestId} declares a non-npm OpenClaw plugin package: ${spec}`,
    );
  }
  if (!parsed.version || !EXACT_NPM_VERSION_PATTERN.test(parsed.version)) {
    throw new MessagingBuildApplierError(
      `Trusted manifest ${manifestId} must use an exact-version OpenClaw plugin package: ${spec}`,
    );
  }
  return { packageSpec: parsed.packageSpec, version: parsed.version };
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

function npmViewString(packageSpec: string, field: string, env: Env): string {
  const result = spawnSync("npm", ["view", packageSpec, field], {
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
    maxBuffer: NPM_METADATA_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new MessagingBuildApplierError(
      `npm view ${packageSpec} ${field} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

function resolveNpmPackArchivePath(packageSpec: string, rootDir: string, filename: string): string {
  const filenameSegments = filename.split(/[\\/]+/);
  if (
    !filename ||
    isAbsolute(filename) ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filenameSegments.includes("..") ||
    filenameSegments.includes("")
  ) {
    throw new MessagingBuildApplierError(
      `npm pack ${packageSpec} reported unsafe archive filename: ${filename}`,
    );
  }

  const root = resolve(rootDir);
  const archivePath = resolve(root, filename);
  if (!archivePath.startsWith(root + sep)) {
    throw new MessagingBuildApplierError(
      `npm pack ${packageSpec} reported archive path outside pack directory: ${filename}`,
    );
  }
  return archivePath;
}

// Reviewed-archive invariants (#5896): registry SRI at the caller, packed-byte
// SRI, a contained basename in a fresh directory, local-archive-only install,
// and cleanup. This Node primitive is shared by all messaging plugin installs.
function packNpmArchive(
  packageSpec: string,
  expectedIntegrity: string,
  env: Env,
): { readonly archivePath: string; readonly rootDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-plugin-pack-"));
  const result = spawnSync("npm", ["pack", packageSpec, "--pack-destination", rootDir, "--json"], {
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
    maxBuffer: NPM_METADATA_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    rmSync(rootDir, { recursive: true, force: true });
    throw new MessagingBuildApplierError(
      `npm pack ${packageSpec} failed${detail ? `: ${detail}` : ""}`,
    );
  }

  let packed: unknown;
  try {
    packed = JSON.parse(String(result.stdout ?? ""));
  } catch (error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw new MessagingBuildApplierError(
      `npm pack ${packageSpec} did not return JSON: ${String(error)}`,
    );
  }
  const [entry] = Array.isArray(packed) ? packed : [];
  const filename = isObject(entry) && typeof entry.filename === "string" ? entry.filename : "";
  const actualIntegrity =
    isObject(entry) && typeof entry.integrity === "string" ? entry.integrity : "";
  if (!filename || !actualIntegrity) {
    rmSync(rootDir, { recursive: true, force: true });
    throw new MessagingBuildApplierError(
      `npm pack ${packageSpec} did not report filename and integrity`,
    );
  }
  if (actualIntegrity !== expectedIntegrity) {
    rmSync(rootDir, { recursive: true, force: true });
    throw new MessagingBuildApplierError(
      `OpenClaw plugin ${packageSpec} downloaded tarball integrity mismatch. Expected: ${expectedIntegrity}. Actual: ${actualIntegrity}`,
    );
  }
  try {
    return { archivePath: resolveNpmPackArchivePath(packageSpec, rootDir, filename), rootDir };
  } catch (error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function packVerifiedOpenClawPluginArchive(
  install: OpenClawPluginInstall,
  env: Env,
): { readonly archivePath: string; readonly rootDir: string } {
  if (!install.npmPackageSpec) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin spec ${install.spec} must use an npm: package with committed integrity pin`,
    );
  }
  if (!install.integrity) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin ${install.npmPackageSpec} has no committed npm integrity pin`,
    );
  }
  if (!install.tarballUrl) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin ${install.npmPackageSpec} has no committed npm tarball URL`,
    );
  }
  const actual = npmViewString(
    install.npmPackageSpec,
    OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY.registryIntegrityField,
    env,
  );
  if (actual !== install.integrity) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin ${install.npmPackageSpec} npm integrity mismatch. Expected: ${install.integrity}. Actual: ${actual}`,
    );
  }
  const actualTarballUrl = npmViewString(
    install.npmPackageSpec,
    OPENCLAW_MESSAGING_PLUGIN_ARCHIVE_PROVENANCE_POLICY.registryTarballField,
    env,
  );
  if (actualTarballUrl !== install.tarballUrl) {
    throw new MessagingBuildApplierError(
      `OpenClaw plugin ${install.npmPackageSpec} npm tarball URL mismatch. Expected: ${install.tarballUrl}. Actual: ${actualTarballUrl}`,
    );
  }
  return packNpmArchive(install.npmPackageSpec, install.integrity, env);
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

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function uniqueStrings<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type MessagingBuildPhase = "runtime-setup" | "agent-install" | "post-agent-install";

export function applyMessagingBuildPhase(
  plan: MessagingBuildPlan | null,
  phase: MessagingBuildPhase,
  env: Env = process.env,
): readonly string[] {
  if (phase === "runtime-setup") {
    const target = writeMessagingRuntimePlanArtifact(plan, messagingRuntimePlanPath(env));
    return target ? [target] : [];
  }
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
  if (plan.agent === "hermes") {
    installHermesMessagingUvPackages(plan, env);
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

function installHermesMessagingUvPackages(plan: MessagingBuildPlan | null, env: Env): void {
  const selectedPackages = collectHermesMessagingUvPackageInstalls(plan).map(
    (install) => install.spec,
  );
  if (selectedPackages.length === 0) return;
  runCommand(
    [
      "uv",
      "pip",
      "install",
      "--python",
      "/opt/hermes/.venv/bin/python",
      "--no-cache",
      "--",
      ...selectedPackages,
    ],
    env,
  );
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
    runtimePlanPath: phase === "runtime-setup" ? messagingRuntimePlanPath(env) : "",
    doctorEnv: plan?.agent === "openclaw" ? openClawDoctorEnvOverrides(plan, env) : {},
    installSpecs:
      plan?.agent === "openclaw" ? collectOpenClawMessagingPluginInstallSpecs(plan, env) : [],
    hermesUvPackages: plan?.agent === "hermes" ? collectHermesMessagingUvPackages(plan) : [],
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
  if (value === "openclaw" || value === "hermes") {
    return value;
  }
  throw new MessagingBuildApplierError("--agent must be 'openclaw' or 'hermes'");
}

function readPhaseArg(value: string | undefined): MessagingBuildPhase {
  if (value === "runtime-setup" || value === "agent-install" || value === "post-agent-install") {
    return value;
  }
  throw new MessagingBuildApplierError(
    "--phase must be 'runtime-setup', 'agent-install', or 'post-agent-install'",
  );
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
