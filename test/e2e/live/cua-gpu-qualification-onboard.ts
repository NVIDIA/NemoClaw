// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs, { type BigIntStats } from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

const MAX_REGISTRY_BYTES = 1024 * 1024;
export const CUA_QUALIFICATION_OPENSHELL_INVENTORY_MAX_BYTES = 64 * 1024;
const MAX_OPENSHELL_SANDBOXES = 64;
const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_SELECTOR = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "RUNNER_TEMP",
  "RUNNER_OS",
  "GITHUB_ACTIONS",
  "CI",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
  "NEMOCLAW_OPENSHELL_CHANNEL",
  "NEMOCLAW_TRACE_DIR",
  "NEMOCLAW_OLLAMA_PULL_TIMEOUT",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
] as const;

const RUNTIME_ENV_KEYS = new Set([
  "PATH",
  "NEMOCLAW_CUA_ENABLED",
  "NEMOCLAW_CUA_QUALIFICATION",
  "NEMOCLAW_CUA_RUNTIME_MANIFEST",
  "NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256",
  "NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT",
  "NEMOCLAW_CUA_QUALIFICATION_ARTIFACT_RUNNER",
  "NEMOCLAW_CUA_SANDBOX_IMAGE_REF",
  "NEMOCLAW_OPENSHELL_BIN",
]);

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  cloud: "build",
  nim: "nim-local",
  "open-router": "openrouter",
  openrouterai: "openrouter",
  anthropiccompatible: "anthropiccompatible",
  hermes: "hermesprovider",
  "hermes-provider": "hermesprovider",
  nous: "hermesprovider",
  "nous-portal": "hermesprovider",
};

const PROVIDER_SECRET_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  build: ["NVIDIA_INFERENCE_API_KEY", "NEMOCLAW_PROVIDER_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  anthropiccompatible: ["COMPATIBLE_ANTHROPIC_API_KEY", "NEMOCLAW_ENDPOINT_URL"],
  gemini: ["GEMINI_API_KEY"],
  hermesprovider: ["OPENAI_API_KEY", "NEMOCLAW_PROVIDER_KEY"],
  custom: ["COMPATIBLE_API_KEY", "NEMOCLAW_ENDPOINT_URL"],
  ollama: ["NEMOCLAW_OLLAMA_PROXY_TOKEN"],
  "llama-cpp": ["NEMOCLAW_LLAMACPP_LOCAL_TOKEN"],
  "nim-local": ["NGC_API_KEY", "NVIDIA_INFERENCE_API_KEY", "NVIDIA_API_KEY"],
  vllm: ["NEMOCLAW_VLLM_LOCAL_TOKEN"],
  routed: ["NEMOCLAW_PROVIDER_KEY", "NVIDIA_INFERENCE_API_KEY", "OPENAI_API_KEY"],
  "install-vllm": ["NEMOCLAW_VLLM_LOCAL_TOKEN"],
  "install-ollama": ["NEMOCLAW_OLLAMA_PROXY_TOKEN"],
  "install-windows-ollama": ["NEMOCLAW_OLLAMA_PROXY_TOKEN"],
  "start-windows-ollama": ["NEMOCLAW_OLLAMA_PROXY_TOKEN"],
};

function requiredSelector(name: string, value: string): string {
  if (!value || value.length > 4096 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${name} is required and invalid`);
  }
  return value;
}

function normalizedProvider(value: string): string {
  const provider = requiredSelector("NEMOCLAW_PROVIDER", value);
  if (!PROVIDER_SELECTOR.test(provider)) {
    throw new Error("NEMOCLAW_PROVIDER must be one printable credential-free provider coordinate");
  }
  const normalized = provider.toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDER_ALIASES, normalized)
    ? PROVIDER_ALIASES[normalized]
    : normalized;
}

export function collectCuaQualificationOnboardSecretEnv(
  env: NodeJS.ProcessEnv,
  provider: string,
): NodeJS.ProcessEnv {
  const providerKey = normalizedProvider(provider);
  const allowedKeys = Object.prototype.hasOwnProperty.call(PROVIDER_SECRET_ENV_KEYS, providerKey)
    ? PROVIDER_SECRET_ENV_KEYS[providerKey]
    : undefined;
  if (!Array.isArray(allowedKeys)) {
    throw new Error(`NEMOCLAW_PROVIDER '${provider}' has no qualification credential mapping`);
  }
  const secretEnv: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = env[key];
    if (value !== undefined) secretEnv[key] = value;
  }
  return secretEnv;
}

export function buildCuaQualificationOnboardEnv(options: {
  baseEnv: NodeJS.ProcessEnv;
  expectedModel: string;
  model: string;
  provider: string;
  runtimeEnv: NodeJS.ProcessEnv;
  secretEnv: NodeJS.ProcessEnv;
}): { env: NodeJS.ProcessEnv; redactionValues: string[] } {
  const provider = requiredSelector("NEMOCLAW_PROVIDER", options.provider);
  const providerKey = normalizedProvider(provider);
  const model = requiredSelector("NEMOCLAW_MODEL", options.model);
  if (model !== options.expectedModel) {
    throw new Error(
      `NEMOCLAW_MODEL must equal the qualification receipt model '${options.expectedModel}'`,
    );
  }
  if (options.baseEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE !== "1") {
    throw new Error("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required for CUA qualification");
  }
  for (const key of Object.keys(options.runtimeEnv)) {
    if (!RUNTIME_ENV_KEYS.has(key)) {
      throw new Error(`CUA qualification runtime env does not allow key '${key}'`);
    }
  }
  const providerSecretEnvKeys = Object.prototype.hasOwnProperty.call(
    PROVIDER_SECRET_ENV_KEYS,
    providerKey,
  )
    ? PROVIDER_SECRET_ENV_KEYS[providerKey]
    : undefined;
  if (!Array.isArray(providerSecretEnvKeys)) {
    throw new Error(`NEMOCLAW_PROVIDER '${provider}' has no qualification credential mapping`);
  }
  for (const key of Object.keys(options.secretEnv)) {
    if (!providerSecretEnvKeys.includes(key)) {
      throw new Error(`CUA qualification onboard secretEnv does not allow key '${key}'`);
    }
  }

  const fixedBaseEnv: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_KEYS) {
    const value = options.baseEnv[key];
    if (value !== undefined) fixedBaseEnv[key] = value;
  }

  const env = {
    ...buildAvailabilityProbeEnv(fixedBaseEnv),
    ...options.runtimeEnv,
    ...options.secretEnv,
    NEMOCLAW_MODEL: model,
    NEMOCLAW_PROVIDER: provider,
  };
  const redactionValues = [
    ...new Set(Object.values(options.secretEnv).filter((value): value is string => !!value)),
  ];
  return { env, redactionValues };
}

export function assertCuaQualificationLocalRegistryAbsent(options: {
  home: string;
  sandboxName: string;
}): void {
  const registryPath = resolveCuaQualificationRegistryPath(options.home);
  let before: BigIntStats;
  try {
    before = fs.lstatSync(registryPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!before.isFile() || before.size > BigInt(MAX_REGISTRY_BYTES)) {
    throw new Error("CUA qualification local sandbox registry is not one bounded regular file");
  }
  const fd = fs.openSync(registryPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw: string;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.nlink !== before.nlink ||
      opened.uid !== before.uid ||
      opened.gid !== before.gid ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs ||
      opened.size > BigInt(MAX_REGISTRY_BYTES)
    ) {
      throw new Error("CUA qualification local sandbox registry changed during bounded validation");
    }
    const expectedSize = Number(opened.size);
    const bytes = Buffer.alloc(Math.min(expectedSize + 1, MAX_REGISTRY_BYTES + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      offset !== expectedSize ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink ||
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error("CUA qualification local sandbox registry changed during bounded validation");
    }
    raw = bytes.subarray(0, offset).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  if (raw.includes("\0")) throw new Error("CUA qualification local sandbox registry is invalid");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("CUA qualification local sandbox registry is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CUA qualification local sandbox registry must be a JSON object");
  }
  const sandboxes = (value as Record<string, unknown>).sandboxes;
  if (
    sandboxes !== undefined &&
    (!sandboxes || typeof sandboxes !== "object" || Array.isArray(sandboxes))
  ) {
    throw new Error("CUA qualification local sandbox registry sandboxes must be an object");
  }
  if (
    sandboxes &&
    Object.prototype.hasOwnProperty.call(sandboxes as Record<string, unknown>, options.sandboxName)
  ) {
    throw new Error(
      `CUA qualification sandbox '${options.sandboxName}' already exists in the local registry`,
    );
  }
}

export function resolveCuaQualificationRegistryPath(home: string): string {
  if (!path.isAbsolute(home) || home.includes("\0")) {
    throw new Error("CUA qualification HOME must be one absolute path");
  }
  return path.join(home, ".nemoclaw", "sandboxes.json");
}

function isStrictOpenShellSandboxRow(value: unknown): value is { name: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const labels = row.labels;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.name === "string" &&
    SANDBOX_NAME.test(row.name) &&
    !!labels &&
    typeof labels === "object" &&
    !Array.isArray(labels) &&
    Object.values(labels as Record<string, unknown>).every((label) => typeof label === "string") &&
    typeof row.resource_version === "number" &&
    Number.isFinite(row.resource_version) &&
    typeof row.created_at === "string" &&
    row.created_at.length > 0 &&
    typeof row.phase === "string" &&
    row.phase.length > 0 &&
    typeof row.current_policy_version === "number" &&
    Number.isFinite(row.current_policy_version)
  );
}

export function parseCuaQualificationOpenShellInventory(stdout: string): string[] {
  if (
    stdout.includes("\0") ||
    Buffer.byteLength(stdout) > CUA_QUALIFICATION_OPENSHELL_INVENTORY_MAX_BYTES
  ) {
    throw new Error("CUA qualification OpenShell inventory exceeded its bounded JSON contract");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("CUA qualification OpenShell inventory is not valid JSON");
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_OPENSHELL_SANDBOXES ||
    !value.every(isStrictOpenShellSandboxRow)
  ) {
    throw new Error(
      "CUA qualification OpenShell inventory has an invalid row shape or cardinality",
    );
  }
  const names = value.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error("CUA qualification OpenShell inventory contains duplicate sandbox names");
  }
  return names.sort();
}

export function assertCuaQualificationSingletonInventory(
  inventory: readonly string[],
  sandboxName: string,
): void {
  if (inventory.length !== 1 || inventory[0] !== sandboxName) {
    throw new Error(
      `CUA qualification onboarding must create exactly one OpenShell sandbox '${sandboxName}'`,
    );
  }
}

export function assertCuaQualificationInventoryTransition(
  before: readonly string[],
  after: readonly string[],
  sandboxName: string,
): void {
  if (before.includes(sandboxName)) {
    throw new Error(`CUA qualification sandbox '${sandboxName}' already exists in OpenShell`);
  }
  const expected = [...before, sandboxName].sort();
  if (after.length !== expected.length || after.some((name, index) => name !== expected[index])) {
    throw new Error(
      `CUA qualification onboarding must add only OpenShell sandbox '${sandboxName}'`,
    );
  }
}

export function isCuaQualificationGatewayUnavailable(result: {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}): boolean {
  return (
    result.exitCode !== 0 &&
    /No (?:active )?gateway|No gateway metadata found|gateway[^\n]*(?:does not exist|not found|unavailable)|connection refused/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  );
}

export function registerCuaQualificationSandboxCleanup(
  cleanup: {
    trackDisposable(name: string, dispose: () => Promise<void> | void): void;
  },
  sandboxName: string,
  callbacks: { nemoclaw: () => Promise<void> | void; openshell: () => Promise<void> | void },
): void {
  cleanup.trackDisposable(
    `delete OpenShell qualification sandbox ${sandboxName}`,
    callbacks.openshell,
  );
  cleanup.trackDisposable(
    `destroy NemoClaw qualification sandbox ${sandboxName}`,
    callbacks.nemoclaw,
  );
}
