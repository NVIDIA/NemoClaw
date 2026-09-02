// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../name-validation";
import { redactFullWithUrls } from "../../security/redact";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  parseCliOpenShellProviderNames,
  runOpenshellProviderCommand,
} from "./provider-command";
import {
  type CreateOpenShellProviderRequest,
  type DeleteOpenShellProviderRequest,
  type DetachOpenShellProviderRequest,
  type ImportOpenShellProviderProfileRequest,
  type InspectOpenShellProviderProfileRequest,
  type OpenShellProviderAdapter,
  type OpenShellProviderError,
  type OpenShellProviderMutationResult,
  type OpenShellProviderRequest,
  type OpenShellProviderResult,
} from "./provider-adapter";
import type { OpenShellGatewayTarget } from "./sandbox-observer";
import {
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
  scopeGatewayOpenshellArgs,
  type OpenShellGatewayEndpointEnvironment,
} from "./gateway-scope";
import {
  exportedProviderProfileMatchesContract,
  parseCheckedInProviderProfileContract,
} from "./provider-profile";

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
    stdio: ["ignore", "pipe", "pipe"];
    suppressOutput?: boolean;
    timeout: number;
  },
) => CapturedProviderCommandResult;

export type CliOpenShellProviderAdapterDeps = Readonly<{
  run?: RunProviderCommand;
  defaultTimeoutMs?: number;
  readProfileFile?: (profilePath: string) => string;
  environment?: OpenShellGatewayEndpointEnvironment;
}>;

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/u;
const TERMINAL_OSC_RE = /(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C|$)/gu;
const TERMINAL_STRING_RE = /(?:\x1B[PX^_]|[\x90\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C|$)/gu;
const TERMINAL_CSI_RE = /(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/gu;
const TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;
const ATTACHED_TO_SANDBOX_RE =
  /attached\s+to(?:\s|│)+sandbox\(\s*es?\s*\)?\s*:\s*([^"\n]+?)(?=\.\s+[a-z]|["\n]|$)/iu;
const TOLERATED_DETACH_OUTPUT_RE = /\bNotAttached\b|\bnot\s+attached\b/iu;

function success<T>(value: T): OpenShellProviderResult<T> {
  return { ok: true, value };
}

function mutationSuccess(): OpenShellProviderMutationResult {
  return { ok: true };
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
    .replace(TERMINAL_OSC_RE, "")
    .replace(TERMINAL_STRING_RE, "")
    .replace(TERMINAL_CSI_RE, "")
    .replace(TERMINAL_CONTROL_RE, "")
    .trim();
}

function redactProviderDiagnostic(output: string, secrets: readonly string[]): string {
  let safe = output;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, "<REDACTED>");
  }
  return redactFullWithUrls(safe).trim();
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
  if (errorCode === "ETIMEDOUT" || /\boperation timed out\b/iu.test(output)) {
    return { kind: "timeout", message: "The OpenShell provider operation timed out." };
  }
  if (errorCode === "ENOENT" || errorCode === "EACCES") {
    return {
      kind: "transport",
      reason: "process_start",
      message: "OpenShell could not start the provider operation.",
    };
  }
  if (result.status === null) {
    return {
      kind: "command",
      reason: "uncertain",
      message: "OpenShell did not report whether the provider operation completed.",
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
  return target.kind === "selected"
    ? [...args]
    : scopeGatewayOpenshellArgs(args, target.gatewayName, gatewayFlagIndex);
}

function namedGatewayEndpointOverrideError(
  target: OpenShellGatewayTarget,
  environment: OpenShellGatewayEndpointEnvironment,
): OpenShellProviderError | null {
  if (target.kind !== "named") return null;
  try {
    assertNoOpenShellGatewayEndpointOverride(environment);
    return null;
  } catch (error) {
    if (!(error instanceof OpenShellGatewayEndpointOverrideError)) throw error;
    return { kind: "validation", message: error.message };
  }
}

function parseProfileCredentialKeys(output: string, expectedProfileId: string): string[] | null {
  let profile: unknown;
  try {
    profile = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return null;
  if (Reflect.get(profile, "id") !== expectedProfileId) return null;
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

export function createCliOpenShellProviderAdapter(
  deps: CliOpenShellProviderAdapterDeps = {},
): OpenShellProviderAdapter {
  const run = deps.run ?? runOpenshellProviderCommand;
  const environment = deps.environment ?? process.env;
  const timeoutFor = (request: OpenShellProviderRequest) =>
    request.timeoutMs ?? deps.defaultTimeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS;
  const invoke = (
    args: string[],
    request: OpenShellProviderRequest,
    env?: Record<string, string>,
    gatewayFlagIndex = 2,
    suppressOutput = false,
  ) =>
    run(scopedArgs(args, request.target, gatewayFlagIndex), {
      ...(env ? { env } : {}),
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(suppressOutput ? { suppressOutput: true } : {}),
      timeout: timeoutFor(request),
    });

  const listProviders: OpenShellProviderAdapter["listProviders"] = async (request) => {
    const targetError = namedGatewayEndpointOverrideError(request.target, environment);
    if (targetError) return failure(targetError);
    const result = invoke(["provider", "list", "--names"], request);
    const error = commandError(result);
    if (error) return failure(error);
    const names = parseCliOpenShellProviderNames(result.stdout);
    if (!names) {
      return failure({
        kind: "schema",
        message: "OpenShell returned an invalid provider inventory.",
      });
    }
    return success({ names });
  };

  const createProvider: OpenShellProviderAdapter["createProvider"] = async (request) => {
    const targetError = namedGatewayEndpointOverrideError(request.target, environment);
    if (targetError) return failure(targetError);
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
    const result = invoke(args, request, env);
    const error = commandError(result, Object.values(env));
    if (request.fromExisting && error?.kind === "command") {
      return failure({
        kind: "command",
        reason: error.reason,
        message: "OpenShell could not create the provider from existing credentials.",
      });
    }
    return error ? failure(error) : mutationSuccess();
  };

  const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async (
    request: ImportOpenShellProviderProfileRequest,
  ) => {
    const targetError = namedGatewayEndpointOverrideError(request.target, environment);
    if (targetError) return failure(targetError);
    const readProfileFile =
      deps.readProfileFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
    const contract = (() => {
      try {
        return parseCheckedInProviderProfileContract(readProfileFile(request.profilePath));
      } catch {
        // Report a fixed validation error below; never return host filesystem diagnostics.
        return null;
      }
    })();
    if (!contract) {
      return failure({
        kind: "validation",
        message: "The checked-in OpenShell provider profile is invalid or unreadable.",
      });
    }
    const result = invoke(
      ["provider", "profile", "import", "--file", request.profilePath],
      request,
    );
    const error = commandError(result);
    const alreadyPresent = error?.kind === "command" && error.reason === "already_exists";
    if (error && !alreadyPresent) return failure(error);

    const exported = invoke(
      ["provider", "profile", "export", contract.profileId, "--output", "json"],
      request,
      undefined,
      2,
      true,
    );
    const exportError = commandError(exported);
    if (exportError) return failure(exportError);
    if (!exportedProviderProfileMatchesContract(bufferOrStringToText(exported.stdout), contract)) {
      return failure({
        kind: "command",
        reason: "profile_incompatible",
        message:
          "The OpenShell provider profile does not match the checked-in credential boundary.",
      });
    }
    return mutationSuccess();
  };

  const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] = async (
    request: InspectOpenShellProviderProfileRequest,
  ) => {
    const targetError = namedGatewayEndpointOverrideError(request.target, environment);
    if (targetError) return failure(targetError);
    const result = invoke(
      ["provider", "profile", "export", request.profileType, "--output", "json"],
      request,
    );
    const error = commandError(result);
    if (error) return failure(error);
    const credentialKeys = parseProfileCredentialKeys(
      bufferOrStringToText(result.stdout),
      request.profileType,
    );
    return credentialKeys
      ? success({ credentialKeys })
      : failure({
          kind: "schema",
          message: "OpenShell returned an invalid provider profile.",
        });
  };

  const deleteProvider: OpenShellProviderAdapter["deleteProvider"] = async (
    request: DeleteOpenShellProviderRequest,
  ) => {
    const targetError = namedGatewayEndpointOverrideError(request.target, environment);
    if (targetError) return failure(targetError);
    const result = invoke(["provider", "delete", request.providerName], request);
    const error = commandError(result);
    return error ? failure(error) : mutationSuccess();
  };

  const detachProvider: OpenShellProviderAdapter["detachProvider"] = async (
    request: DetachOpenShellProviderRequest,
  ) => {
    const targetError = namedGatewayEndpointOverrideError(request.target, environment);
    if (targetError) return failure(targetError);
    const result = invoke(
      ["sandbox", "provider", "detach", request.sandboxName, request.providerName],
      request,
      undefined,
      3,
    );
    const output = commandOutput(result);
    if (result.status !== 0 && TOLERATED_DETACH_OUTPUT_RE.test(output)) {
      return mutationSuccess();
    }
    const error = commandError(result);
    return error ? failure(error) : mutationSuccess();
  };

  return {
    listProviders,
    createProvider,
    importProviderProfile,
    inspectProviderProfile,
    deleteProvider,
    detachProvider,
  };
}
