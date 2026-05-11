// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";

import { runOpenshell } from "../adapters/openshell/runtime";
import {
  getProviderSelectionConfig,
  getSandboxInferenceConfig,
  type SandboxInferenceConfig,
} from "../inference/config";
import type { ConfigObject, ConfigValue } from "../security/credential-filter";
import { isConfigObject, isConfigValue } from "../security/credential-filter";
import {
  readSandboxConfig,
  recomputeSandboxConfigHash,
  resolveAgentConfig,
  type AgentConfigTarget,
  writeSandboxConfig,
} from "../sandbox-config";
import { appendAuditEntry } from "../shields/audit";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import type { SandboxEntry } from "../state/registry";
import { isSafeModelId } from "../validation";

export interface InferenceSetOptions {
  provider: string;
  model: string;
  sandboxName?: string | null;
  noVerify?: boolean;
}

export interface InferenceSetResult {
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  providerKey: string;
  configChanged: boolean;
  sessionUpdated: boolean;
}

type OpenshellRunResult = Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;

export interface InferenceSetDeps {
  getDefaultSandbox: () => string | null;
  getSandbox: (name: string) => SandboxEntry | null;
  updateSandbox: (name: string, updates: Partial<SandboxEntry>) => boolean;
  loadSession: () => onboardSession.Session | null;
  updateSession: (
    mutator: (session: onboardSession.Session) => onboardSession.Session | void,
  ) => onboardSession.Session;
  resolveAgentConfig: (sandboxName: string) => AgentConfigTarget;
  readSandboxConfig: (sandboxName: string, target: AgentConfigTarget) => ConfigObject;
  writeSandboxConfig: (
    sandboxName: string,
    target: AgentConfigTarget,
    config: ConfigObject,
  ) => void;
  recomputeSandboxConfigHash: (sandboxName: string, target: AgentConfigTarget) => void;
  runOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => OpenshellRunResult;
  appendAuditEntry: typeof appendAuditEntry;
  log: (message: string) => void;
}

export class InferenceSetError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "InferenceSetError";
  }
}

const SUPPORTED_PROVIDER_NAMES = [
  "nvidia-prod",
  "nvidia-nim",
  "nvidia-router",
  "openai-api",
  "anthropic-prod",
  "compatible-anthropic-endpoint",
  "gemini-api",
  "compatible-endpoint",
  "ollama-local",
  "vllm-local",
] as const;

function defaultDeps(): InferenceSetDeps {
  return {
    getDefaultSandbox: registry.getDefault,
    getSandbox: registry.getSandbox,
    updateSandbox: registry.updateSandbox,
    loadSession: onboardSession.loadSession,
    updateSession: onboardSession.updateSession,
    resolveAgentConfig,
    readSandboxConfig,
    writeSandboxConfig,
    recomputeSandboxConfigHash,
    runOpenshell: (args, opts) => runOpenshell(args, opts),
    appendAuditEntry,
    log: console.log,
  };
}

function trimRequired(value: string | null | undefined, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new InferenceSetError(`${label} is required.`);
  return trimmed;
}

function assertSupportedProvider(provider: string, model: string): void {
  if (getProviderSelectionConfig(provider, model) || provider === "nvidia-router") return;
  throw new InferenceSetError(
    `Unsupported provider '${provider}'. Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`,
    2,
  );
}

function normalizeSandboxAgent(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return trimmed || "openclaw";
}

function resolveTargetSandbox(
  sandboxName: string | null | undefined,
  deps: Pick<InferenceSetDeps, "getDefaultSandbox" | "getSandbox">,
): { sandboxName: string; entry: SandboxEntry } {
  const targetName = sandboxName?.trim() || deps.getDefaultSandbox();
  if (!targetName) {
    throw new InferenceSetError(
      "No sandbox selected. Pass --sandbox <name> or create a sandbox with nemoclaw onboard.",
      2,
    );
  }

  const entry = deps.getSandbox(targetName);
  if (!entry) {
    throw new InferenceSetError(`Sandbox '${targetName}' is not registered.`, 2);
  }
  if (normalizeSandboxAgent(entry.agent) !== "openclaw") {
    throw new InferenceSetError(
      `nemoclaw inference set currently supports OpenClaw sandboxes; '${targetName}' uses '${entry.agent}'.`,
      2,
    );
  }
  return { sandboxName: targetName, entry };
}

function ensureObject(record: ConfigObject, key: string): ConfigObject {
  const existing = record[key];
  if (isConfigObject(existing)) return existing;
  const created: ConfigObject = {};
  record[key] = created;
  return created;
}

function cloneConfigObject(value: ConfigValue | undefined): ConfigObject {
  if (!isConfigObject(value)) return {};
  return { ...value };
}

function asConfigObject(value: Record<string, unknown>): ConfigObject {
  const result: ConfigObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isConfigValue(entry as ConfigValue)) result[key] = entry as ConfigValue;
  }
  return result;
}

function updateAgentPrimary(config: ConfigObject, primaryModelRef: string): void {
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const model = ensureObject(defaults, "model");
  model.primary = primaryModelRef;
}

function buildProviderConfig(
  existing: ConfigObject,
  model: string,
  route: SandboxInferenceConfig,
): ConfigObject {
  const firstExistingModel = Array.isArray(existing.models)
    ? cloneConfigObject(existing.models[0])
    : {};
  delete firstExistingModel.compat;
  firstExistingModel.id = model;
  firstExistingModel.name = route.primaryModelRef;
  if (route.inferenceCompat) {
    firstExistingModel.compat = asConfigObject(route.inferenceCompat);
  }

  return {
    ...existing,
    baseUrl: route.inferenceBaseUrl,
    apiKey: typeof existing.apiKey === "string" && existing.apiKey ? existing.apiKey : "unused",
    api: route.inferenceApi,
    models: [firstExistingModel],
  };
}

export function patchOpenClawInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);

  updateAgentPrimary(config, route.primaryModelRef);

  const models = ensureObject(config, "models");
  models.mode = "merge";
  const providers = ensureObject(models, "providers");
  const existingProvider = cloneConfigObject(providers[route.providerKey]);
  providers[route.providerKey] = buildProviderConfig(existingProvider, model, route);

  return { changed: before !== JSON.stringify(config), route };
}

function updateMatchingOnboardSession(
  sandboxName: string,
  provider: string,
  model: string,
  deps: Pick<InferenceSetDeps, "loadSession" | "updateSession">,
): boolean {
  const session = deps.loadSession();
  if (!session || session.sandboxName !== sandboxName) return false;
  deps.updateSession((current) => {
    if (current.sandboxName !== sandboxName) return current;
    current.provider = provider;
    current.model = model;
    current.endpointUrl =
      getProviderSelectionConfig(provider, model)?.endpointUrl ?? current.endpointUrl;
    return current;
  });
  return true;
}

function openshellInferenceSetArgs(options: {
  provider: string;
  model: string;
  noVerify?: boolean;
}): string[] {
  const args = [
    "inference",
    "set",
    "-g",
    "nemoclaw",
    "--provider",
    options.provider,
    "--model",
    options.model,
  ];
  if (options.noVerify) args.push("--no-verify");
  return args;
}

function getPreferredInferenceApi(config: ConfigObject): string | null {
  const models = config.models;
  if (!isConfigObject(models)) return null;
  const providers = models.providers;
  if (!isConfigObject(providers)) return null;
  const inferenceProvider = providers.inference;
  if (!isConfigObject(inferenceProvider)) return null;
  return typeof inferenceProvider.api === "string" ? inferenceProvider.api : null;
}

export async function runInferenceSet(
  options: InferenceSetOptions,
  deps: InferenceSetDeps = defaultDeps(),
): Promise<InferenceSetResult> {
  const provider = trimRequired(options.provider, "provider");
  const model = trimRequired(options.model, "model");
  assertSupportedProvider(provider, model);
  if (!isSafeModelId(model)) {
    throw new InferenceSetError(
      "Invalid model id. Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      2,
    );
  }

  const { sandboxName } = resolveTargetSandbox(options.sandboxName, deps);
  const target = deps.resolveAgentConfig(sandboxName);
  if (target.agentName !== "openclaw") {
    throw new InferenceSetError(
      `nemoclaw inference set currently supports OpenClaw configs; '${sandboxName}' uses '${target.agentName}'.`,
      2,
    );
  }

  const config = deps.readSandboxConfig(sandboxName, target);
  const patched = patchOpenClawInferenceConfig(
    config,
    provider,
    model,
    getPreferredInferenceApi(config),
  );

  deps.log(`  Setting OpenShell inference route: ${provider} / ${model}`);
  const setResult = deps.runOpenshell(openshellInferenceSetArgs({ provider, model, noVerify: options.noVerify }), {
    ignoreError: true,
  });
  if (setResult.status !== 0) {
    throw new InferenceSetError(
      `OpenShell inference route update failed with exit ${setResult.status ?? 1}.`,
      setResult.status ?? 1,
    );
  }

  deps.log(`  Syncing OpenClaw model identity in sandbox '${sandboxName}'...`);
  deps.writeSandboxConfig(sandboxName, target, config);
  deps.recomputeSandboxConfigHash(sandboxName, target);

  if (!deps.updateSandbox(sandboxName, { provider, model })) {
    throw new InferenceSetError(`Failed to update NemoClaw registry for sandbox '${sandboxName}'.`);
  }
  const sessionUpdated = updateMatchingOnboardSession(sandboxName, provider, model, deps);

  deps.appendAuditEntry({
    action: "shields_down",
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set openclaw:${provider}:${model}`,
  });

  deps.log(`  Inference route synced for '${sandboxName}': ${patched.route.primaryModelRef}`);

  return {
    sandboxName,
    provider,
    model,
    primaryModelRef: patched.route.primaryModelRef,
    providerKey: patched.route.providerKey,
    configChanged: patched.changed,
    sessionUpdated,
  };
}
