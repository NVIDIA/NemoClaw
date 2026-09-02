// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../name-validation";
import { redactFull } from "../../security/redact";
import { parseCliOpenShellProviderNames, runOpenshellProviderCommand } from "./provider-command";
import {
  type AttachOpenShellProviderRequest,
  type ConfigureOpenShellProviderRefreshRequest,
  type CreateOpenShellProviderRequest,
  type DeleteOpenShellProviderRequest,
  type DetachOpenShellProviderRequest,
  type EnsureOpenShellEndpointlessProviderProfileRequest,
  type GetOpenShellProviderRequest,
  type GetOpenShellProviderRefreshStatusRequest,
  type ImportOpenShellProviderProfileRequest,
  type InspectOpenShellProviderProfileRequest,
  type OpenShellProviderAdapter,
  type OpenShellProviderError,
  type OpenShellProviderInspectionAdapter,
  type OpenShellProviderRequest,
  type OpenShellProviderResult,
  type UpdateOpenShellProviderRequest,
} from "./provider-adapter";
import { reportsExactProviderNotFound } from "./provider-diagnostic-cli";
import {
  isValidCliOpenShellProviderIdentifier,
  parseCliOpenShellProviderMetadata,
} from "./provider-metadata-cli";
import type { OpenShellGatewayTarget } from "./sandbox-observer";
import { ensureEndpointlessProviderProfile as reconcileEndpointlessProviderProfile } from "./provider-profile";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";
import { providerProfileContractDigest } from "./provider-profile-contract";

export type CapturedProviderCommandResult = Readonly<{
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
}>;

export type RunProviderCommand = (
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    ignoreError: true;
    maxBuffer?: number;
    stdio: ["ignore", "pipe", "pipe"];
    suppressOutput?: boolean;
    timeout: number;
  },
) => CapturedProviderCommandResult;

export type CliOpenShellProviderAdapterDeps = Readonly<{
  run?: RunProviderCommand;
  defaultTimeoutMs?: number;
}>;

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/u;
const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const ATTACHED_TO_SANDBOX_RE = /attached\s+to(?:\s|│)+sandbox\(\s*es?\s*\)?\s*:\s*([^".\n]+)/iu;
const TOLERATED_DETACH_OUTPUT_RE =
  /\bNotAttached\b|\bnot\s+attached\b|provider[^\n]{0,200}?(?:\bNotFound\b|\bnot\s+found\b)/iu;
const PROVIDER_GET_DIAGNOSTIC_LIMIT = 64 * 1024;

function success<T>(value: T): OpenShellProviderResult<T> {
  return { ok: true, value };
}

function failure<T>(error: OpenShellProviderError): OpenShellProviderResult<T> {
  return { ok: false, error };
}

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  return value?.toString() ?? "";
}

function commandOutput(result: CapturedProviderCommandResult): string {
  return `${bufferOrStringToText(result.stderr)}\n${bufferOrStringToText(result.stdout)}`
    .replace(ANSI_RE, "")
    .trim();
}

function redactProviderDiagnostic(output: string, secrets: readonly string[]): string {
  let safe = output;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, "<REDACTED>");
  }
  return redactFull(safe).trim();
}

function attachedSandboxNames(output: string): string[] | null {
  const match = ATTACHED_TO_SANDBOX_RE.exec(output);
  if (!match?.[1]) return null;
  const names = match[1]
    .split(/[,\s]+/u)
    .map((name) => name.trim().replace(/[.'"`]+$/u, ""))
    .filter(Boolean);
  if (
    names.length === 0 ||
    names.some((name) => name.length > NAME_MAX_LENGTH || !NAME_VALID_PATTERN.test(name))
  ) {
    return null;
  }
  return names;
}

function commandError(
  result: CapturedProviderCommandResult,
  secrets: readonly string[] = [],
): OpenShellProviderError | null {
  if (result.status === 0) return null;
  const output = commandOutput(result);
  const message = redactProviderDiagnostic(output, secrets);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ETIMEDOUT") {
    return { kind: "timeout", message: "The OpenShell provider operation timed out." };
  }
  if (errorCode === "ENOENT" || errorCode === "EACCES") {
    return {
      kind: "transport",
      reason: "process_start",
      message: "OpenShell could not start the provider operation.",
    };
  }
  if (/invalid wire type|proto(?:buf)?(?: decode| schema| wire)/iu.test(output)) {
    return {
      kind: "schema",
      message: "The OpenShell CLI and gateway provider schemas do not match.",
    };
  }
  if (
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "authentication",
      message: "OpenShell could not authenticate the provider operation.",
    };
  }
  if (/\bhandshake verification failed\b/iu.test(output)) {
    return {
      kind: "transport",
      reason: "identity_mismatch",
      message: "The selected OpenShell gateway identity does not match the recorded identity.",
    };
  }
  if (
    /\b(?:connection refused|client error \(connect\)|tcp connect error|transport error|connection reset|connection aborted|connection closed|no active gateway|no gateway configured)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "transport",
      reason: "unreachable",
      message: "OpenShell could not reach the selected gateway.",
    };
  }
  if (/already exists/iu.test(output)) {
    return { kind: "command", reason: "already_exists", message };
  }
  const attachedSandboxes = attachedSandboxNames(output);
  if (attachedSandboxes) {
    return { kind: "command", reason: "attached", message, attachedSandboxes };
  }
  if (/\bNotFound\b|\bnot\s+found\b|does\s+not\s+exist|already\s+absent/iu.test(output)) {
    return { kind: "command", reason: "not_found", message };
  }
  return {
    kind: "command",
    reason: result.status === 2 ? "invalid_request" : "failed",
    message: message || "The OpenShell provider operation failed.",
  };
}

function scopedArgs(
  args: string[],
  target: OpenShellGatewayTarget,
  gatewayFlagIndex = 2,
): string[] {
  if (target.kind === "selected") return args;
  return [
    ...args.slice(0, gatewayFlagIndex),
    "-g",
    target.gatewayName,
    ...args.slice(gatewayFlagIndex),
  ];
}

function parseProfileCredentialKeys(output: string): string[] | null {
  let profile: unknown;
  try {
    profile = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return null;
  const credentials = Reflect.get(profile, "credentials");
  if (!Array.isArray(credentials)) return null;
  const keys = new Set<string>();
  for (const credential of credentials) {
    if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
      return null;
    }
    const envVars = Reflect.get(credential, "env_vars");
    if (!Array.isArray(envVars)) return null;
    for (const key of envVars) {
      if (typeof key !== "string" || !ENV_NAME_PATTERN.test(key)) return null;
      keys.add(key);
    }
  }
  return [...keys].sort();
}

function parseProviderProfile(output: string):
  | Readonly<{ credentialKeys: readonly string[]; contractDigest: string }>
  | null {
  let profile: unknown;
  try {
    profile = JSON.parse(output);
  } catch {
    return null;
  }
  const credentialKeys = parseProfileCredentialKeys(output);
  const contractDigest = providerProfileContractDigest(profile);
  return credentialKeys && contractDigest ? { credentialKeys, contractDigest } : null;
}

function parseRefreshStatus(output: string, credentialKey: string): string | null {
  const row = output
    .split("\n")
    .map((line) => line.replace(ANSI_RE, "").trim())
    .find((line) => line.includes(credentialKey));
  const columns = (row ?? "").split(/\s{2,}/u).filter(Boolean);
  const keyIndex = columns.indexOf(credentialKey);
  return keyIndex < 0 ? null : (columns[keyIndex + 2] ?? null);
}

type InvokeProviderCommand = (
  args: string[],
  request: OpenShellProviderRequest,
  env?: Record<string, string>,
  gatewayFlagIndex?: number,
  suppressOutput?: boolean,
  maxBuffer?: number,
) => CapturedProviderCommandResult;

function createProviderCommandInvoker(
  deps: CliOpenShellProviderAdapterDeps,
): InvokeProviderCommand {
  const run = deps.run ?? runOpenshellProviderCommand;
  const timeoutFor = (request: OpenShellProviderRequest) =>
    request.timeoutMs ?? deps.defaultTimeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS;
  return (
    args,
    request,
    env,
    gatewayFlagIndex = 2,
    suppressOutput = false,
    maxBuffer,
  ) =>
    run(scopedArgs(args, request.target, gatewayFlagIndex), {
      ...(env ? { env } : {}),
      ignoreError: true,
      ...(maxBuffer ? { maxBuffer } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      ...(suppressOutput ? { suppressOutput: true } : {}),
      timeout: timeoutFor(request),
    });
}

function inspectProvider(
  invoke: InvokeProviderCommand,
  request: GetOpenShellProviderRequest,
): ReturnType<OpenShellProviderInspectionAdapter["getProvider"]> {
  if (!isValidCliOpenShellProviderIdentifier(request.providerName)) {
    return failure({ kind: "validation", message: "Provider name is invalid." });
  }
  const result = invoke(
    ["provider", "get", request.providerName],
    request,
    undefined,
    2,
    true,
    PROVIDER_GET_DIAGNOSTIC_LIMIT,
  );
  const output = commandOutput(result);
  if (
    result.status === 1 &&
    reportsExactProviderNotFound(output, request.providerName, PROVIDER_GET_DIAGNOSTIC_LIMIT)
  ) {
    return failure({
      kind: "command",
      reason: "not_found",
      message: `OpenShell provider '${request.providerName}' was not found.`,
    });
  }
  const error = commandError(result);
  if (error) {
    return failure(
      error.kind === "command" && error.reason === "not_found"
        ? {
            kind: "command",
            reason: "failed",
            message: "OpenShell could not inspect the selected provider.",
          }
        : error,
    );
  }
  const metadata = parseCliOpenShellProviderMetadata(output);
  return metadata?.name === request.providerName
    ? success(metadata)
    : failure({ kind: "schema", message: "OpenShell returned invalid provider metadata." });
}

function inspectProfile(
  invoke: InvokeProviderCommand,
  request: InspectOpenShellProviderProfileRequest,
): ReturnType<OpenShellProviderInspectionAdapter["inspectProviderProfile"]> {
  const result = invoke(
    ["provider", "profile", "export", request.profileType, "--output", "json"],
    request,
    undefined,
    2,
    true,
  );
  const error = commandError(result);
  if (error) return failure(error);
  const inspection = parseProviderProfile(bufferOrStringToText(result.stdout));
  return inspection
    ? success(inspection)
    : failure({
        kind: "schema",
        message: "OpenShell returned an invalid provider profile.",
      });
}

/** Create the synchronous typed inspection boundary used by onboarding planning. */
export function createCliOpenShellProviderInspectionAdapter(
  deps: CliOpenShellProviderAdapterDeps = {},
): OpenShellProviderInspectionAdapter {
  const invoke = createProviderCommandInvoker(deps);
  return {
    getProvider: (request) => inspectProvider(invoke, request),
    inspectProviderProfile: (request) => inspectProfile(invoke, request),
  };
}

export function createCliOpenShellProviderAdapter(
  deps: CliOpenShellProviderAdapterDeps = {},
): OpenShellProviderAdapter {
  const invoke = createProviderCommandInvoker(deps);

  const listProviders: OpenShellProviderAdapter["listProviders"] = async (request) => {
    const result = invoke(["provider", "list", "--names"], request);
    const error = commandError(result);
    if (error) return failure(error);
    return success({
      names: parseCliOpenShellProviderNames(result.stdout),
    });
  };

  const createProvider: OpenShellProviderAdapter["createProvider"] = async (request) => {
    if (
      (!request.fromExisting && request.credentials.length === 0) ||
      (request.fromExisting && request.credentials.length > 0) ||
      request.credentials.some(
        (credential) => !ENV_NAME_PATTERN.test(credential.name) || credential.value.length === 0,
      )
    ) {
      return failure({
        kind: "validation",
        message: "Provider credential input is missing or conflicts with imported credentials.",
      });
    }
    const args = ["provider", "create", "--name", request.name, "--type", request.type];
    if (request.fromExisting) {
      args.push("--from-existing");
    } else {
      for (const credential of request.credentials) args.push("--credential", credential.name);
    }
    for (const entry of request.config) args.push("--config", `${entry.key}=${entry.value}`);
    const env = Object.fromEntries(
      request.credentials.map((credential) => [credential.name, credential.value]),
    );
    const result = invoke(args, request, request.credentials.length > 0 ? env : undefined);
    const error = commandError(result, Object.values(env));
    if (request.fromExisting && error?.kind === "command") {
      return failure({
        kind: "command",
        reason: error.reason,
        message: "OpenShell could not create the provider from existing credentials.",
      });
    }
    return error ? failure(error) : success({ state: "created" });
  };

  const getProvider: OpenShellProviderAdapter["getProvider"] = async (
    request: GetOpenShellProviderRequest,
  ) => inspectProvider(invoke, request);

  const updateProvider: OpenShellProviderAdapter["updateProvider"] = async (
    request: UpdateOpenShellProviderRequest,
  ) => {
    if (
      !isValidCliOpenShellProviderIdentifier(request.providerName) ||
      request.credentials.some(
        (credential) => !ENV_NAME_PATTERN.test(credential.name) || credential.value.length === 0,
      )
    ) {
      return failure({ kind: "validation", message: "Provider update input is invalid." });
    }
    const args = ["provider", "update", request.providerName];
    for (const credential of request.credentials) args.push("--credential", credential.name);
    for (const entry of request.config) args.push("--config", `${entry.key}=${entry.value}`);
    const env = Object.fromEntries(
      request.credentials.map((credential) => [credential.name, credential.value]),
    );
    const result = invoke(args, request, env);
    const error = commandError(result, Object.values(env));
    return error ? failure(error) : success({ state: "updated" });
  };

  const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async (
    request: ImportOpenShellProviderProfileRequest,
  ) => {
    const result = invoke(
      ["provider", "profile", "import", "--file", request.profilePath],
      request,
    );
    const error = commandError(result);
    if (error?.kind === "command" && error.reason === "already_exists") {
      return success({ state: "already_present" });
    }
    return error ? failure(error) : success({ state: "imported" });
  };

  const ensureEndpointlessProviderProfile: OpenShellProviderAdapter["ensureEndpointlessProviderProfile"] =
    async (request: EnsureOpenShellEndpointlessProviderProfileRequest) => {
      const result = reconcileEndpointlessProviderProfile({
        profileId: request.profileType,
        inferenceCapable: request.inferenceCapable,
        profilePath: request.profilePath,
        runOpenshell: (args, options) =>
          invoke(args, request, undefined, 2, options?.suppressOutput === true),
      });
      if (result.ok) return success({ state: "ready" });
      const reason =
        result.reason === "export-failed"
          ? "profile_export_failed"
          : result.reason === "import-failed"
            ? "profile_import_failed"
            : "profile_incompatible";
      const message =
        result.reason === "export-failed"
          ? "OpenShell could not read the provider profile for validation."
          : result.reason === "import-failed"
            ? "OpenShell could not import the provider profile."
            : "The existing OpenShell provider profile does not match the required contract.";
      return failure({ kind: "command", reason, message });
    };

  const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] = async (
    request: InspectOpenShellProviderProfileRequest,
  ) => inspectProfile(invoke, request);

  const deleteProvider: OpenShellProviderAdapter["deleteProvider"] = async (
    request: DeleteOpenShellProviderRequest,
  ) => {
    const result = invoke(["provider", "delete", request.providerName], request);
    const error = commandError(result);
    return error ? failure(error) : success({ state: "deleted" });
  };

  const detachProvider: OpenShellProviderAdapter["detachProvider"] = async (
    request: DetachOpenShellProviderRequest,
  ) => {
    const result = invoke(
      ["sandbox", "provider", "detach", request.sandboxName, request.providerName],
      request,
      undefined,
      3,
    );
    const output = commandOutput(result);
    if (result.status !== 0 && TOLERATED_DETACH_OUTPUT_RE.test(output)) {
      return success({ state: "absent" });
    }
    const error = commandError(result);
    return error ? failure(error) : success({ state: "detached" });
  };

  const attachProvider: OpenShellProviderAdapter["attachProvider"] = async (
    request: AttachOpenShellProviderRequest,
  ) => {
    const result = invoke(
      ["sandbox", "provider", "attach", request.sandboxName, request.providerName],
      request,
      undefined,
      3,
    );
    const error = commandError(result);
    return error ? failure(error) : success({ state: "attached" });
  };

  const configureProviderRefresh: OpenShellProviderAdapter["configureProviderRefresh"] = async (
    request: ConfigureOpenShellProviderRefreshRequest,
  ) => {
    if (
      !isValidCliOpenShellProviderIdentifier(request.providerName) ||
      !ENV_NAME_PATTERN.test(request.credentialKey) ||
      !request.strategy ||
      request.material.some((entry) => !entry.key || !entry.value) ||
      request.secretMaterial.some((entry) => !entry.key || !entry.value)
    ) {
      return failure({ kind: "validation", message: "Provider refresh input is invalid." });
    }
    const args = [
      "provider",
      "refresh",
      "configure",
      "--credential-key",
      request.credentialKey,
      "--strategy",
      request.strategy,
    ];
    for (const entry of request.material) args.push("--material", `${entry.key}=${entry.value}`);
    const env: Record<string, string> = {};
    request.secretMaterial.forEach((entry, index) => {
      const envName = `NEMOCLAW_PROVIDER_REFRESH_SECRET_${index}`;
      env[envName] = entry.value;
      args.push("--secret-material-env", `${entry.key}=${envName}`);
    });
    args.push(request.providerName);
    const result = invoke(args, request, env);
    const error = commandError(result, Object.values(env));
    return error ? failure(error) : success({ state: "configured" });
  };

  const getProviderRefreshStatus: OpenShellProviderAdapter["getProviderRefreshStatus"] = async (
    request: GetOpenShellProviderRefreshStatusRequest,
  ) => {
    const result = invoke(
      [
        "provider",
        "refresh",
        "status",
        request.providerName,
        "--credential-key",
        request.credentialKey,
      ],
      request,
      undefined,
      2,
      true,
    );
    const error = commandError(result);
    return error
      ? failure(error)
      : success({
          status: parseRefreshStatus(
            bufferOrStringToText(result.stdout),
            request.credentialKey,
          ),
        });
  };

  return {
    listProviders,
    createProvider,
    getProvider,
    updateProvider,
    importProviderProfile,
    ensureEndpointlessProviderProfile,
    inspectProviderProfile,
    deleteProvider,
    detachProvider,
    attachProvider,
    configureProviderRefresh,
    getProviderRefreshStatus,
  };
}
