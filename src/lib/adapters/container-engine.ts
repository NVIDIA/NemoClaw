// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

export type ContainerEngineOperationScope =
  | "host-doctor"
  | "host-local-inference"
  | "gateway-inspection"
  | "managed-bootstrap"
  | "sandbox-lifecycle"
  | "state-mutation"
  | "workload-cleanup";

export interface ContainerEngineCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type ContainerEngineCommandCapture = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  input?: Buffer,
  environment?: Readonly<Record<string, string>>,
) => ContainerEngineCommandResult;

/**
 * Immutable command boundary injected into one provider operation. The
 * executable and endpoint prefix cannot change after construction, and no
 * process-global engine selection is consulted by a command.
 */
export interface ContainerEngine {
  readonly operation: ContainerEngineOperationScope;
  readonly engineId: string;
  readonly displayName: string;
  /** Opaque identity for the full operation authority bound to this command. */
  readonly authorityId: string;
  /**
   * Opaque identity for the shared endpoint authority, excluding stricter
   * operation-only bindings. Absent legacy engines use authorityId.
   */
  readonly endpointAuthorityId?: string;
  readonly capture: (
    args: readonly string[],
    timeoutMs?: number,
    input?: Buffer,
  ) => ContainerEngineCommandResult;
  /** Available only to a host-local-inference engine; values remain operation-scoped. */
  readonly captureWithEnvironment?: (
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
    timeoutMs?: number,
    input?: Buffer,
  ) => ContainerEngineCommandResult;
  readonly captureHost: (
    args: readonly string[],
    timeoutMs?: number,
  ) => ContainerEngineCommandResult;
}

export interface ContainerEngineCommandOptions {
  readonly operation: ContainerEngineOperationScope;
  readonly engineId: string;
  readonly displayName: string;
  readonly authorityId: string;
  readonly endpointAuthorityId?: string;
  readonly executable: string;
  readonly endpointArgs?: readonly string[];
  /** Exact operation-scoped names that may be added to the sanitized child environment. */
  readonly allowedEnvironmentNames?: readonly string[];
  /** Complete child environment for one authority-bound engine operation. */
  readonly commandEnvironment?: Readonly<Record<string, string>>;
  readonly capture?: ContainerEngineCommandCapture;
  readonly guard?: (phase: "before" | "after") => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 32;
const MAX_ENVIRONMENT_BYTES = 64 * 1024;
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const AUTHORITY_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}:[A-Za-z0-9._:-]{1,255}$/u;
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const COMMAND_ENV_NAMES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TERM",
  "HOSTNAME",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "CURL_CA_BUNDLE",
]);
const COMMAND_ENV_PREFIXES = ["LC_", "XDG_"] as const;
const ENGINE_ENV_NAMES = new Set([
  "CONTAINER_CONNECTION",
  "CONTAINER_HOST",
  "CONTAINER_SSHKEY",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);

function containerEngineCommandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (COMMAND_ENV_NAMES.has(name) ||
        COMMAND_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

function operationCommandEnvironment(
  explicit: Readonly<Record<string, string>>,
  allowedNames: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (typeof explicit !== "object" || explicit === null || Array.isArray(explicit)) {
    throw new Error("Container engine command environment is invalid.");
  }
  const entries = Object.entries(explicit);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new Error("Container engine command environment has too many entries.");
  }
  let totalBytes = 0;
  const normalized: Record<string, string> = Object.create(null);
  for (const [name, value] of entries) {
    if (
      !ENVIRONMENT_NAME_PATTERN.test(name) ||
      !allowedNames.has(name) ||
      COMMAND_ENV_NAMES.has(name) ||
      COMMAND_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      ENGINE_ENV_NAMES.has(name)
    ) {
      throw new Error("Container engine command environment name is invalid or reserved.");
    }
    if (
      typeof value !== "string" ||
      value === "" ||
      Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES ||
      CONTROL_CHARACTERS.test(value)
    ) {
      throw new Error("Container engine command environment value is invalid.");
    }
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_ENVIRONMENT_BYTES) {
      throw new Error("Container engine command environment exceeds its byte bound.");
    }
    normalized[name] = value;
  }
  return Object.freeze({
    ...containerEngineCommandEnvironment(),
    ...normalized,
  });
}

function replacementCommandEnvironment(
  explicit: Readonly<Record<string, string>>,
  allowedNames: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (typeof explicit !== "object" || explicit === null || Array.isArray(explicit)) {
    throw new Error("Container engine command environment is invalid.");
  }
  const entries = Object.entries(explicit);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new Error("Container engine command environment has too many entries.");
  }
  let totalBytes = 0;
  const normalized: Record<string, string> = Object.create(null);
  for (const [name, value] of entries) {
    if (
      !ENVIRONMENT_NAME_PATTERN.test(name) ||
      ENGINE_ENV_NAMES.has(name) ||
      (!COMMAND_ENV_NAMES.has(name) &&
        !COMMAND_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
        !allowedNames.has(name))
    ) {
      throw new Error("Container engine command environment name is invalid.");
    }
    if (
      typeof value !== "string" ||
      value === "" ||
      Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES ||
      CONTROL_CHARACTERS.test(value)
    ) {
      throw new Error("Container engine command environment value is invalid.");
    }
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_ENVIRONMENT_BYTES) {
      throw new Error("Container engine command environment exceeds its byte bound.");
    }
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

function boundedText(value: string, label: string, allowPath = false): string {
  const normalized = value.trim();
  if (
    normalized === "" ||
    Buffer.byteLength(normalized, "utf8") > MAX_ARGUMENT_BYTES ||
    CONTROL_CHARACTERS.test(normalized) ||
    (!allowPath && /[\\/]/u.test(normalized))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function normalizedArguments(args: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) {
    throw new Error(`${label} has too many arguments.`);
  }
  return Object.freeze(
    args.map((value, index) => {
      if (
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES ||
        value.includes("\0")
      ) {
        throw new Error(`${label}[${String(index)}] is invalid.`);
      }
      return value;
    }),
  );
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Container engine command timeout must be a positive safe integer.");
  }
  return value;
}

function normalizedExecutable(value: string): string {
  const executable = boundedText(value, "Container engine executable", true);
  if (!path.isAbsolute(executable) && !EXECUTABLE_NAME_PATTERN.test(executable)) {
    throw new Error("Container engine executable is invalid.");
  }
  return executable;
}

function normalizedResult(value: ContainerEngineCommandResult): ContainerEngineCommandResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.status) ||
    value.status < 0 ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    (value.error !== undefined && !(value.error instanceof Error))
  ) {
    throw new Error("Container engine command returned an invalid result.");
  }
  return Object.freeze({
    status: value.status,
    stdout: value.stdout,
    stderr: value.stderr,
    ...(value.error ? { error: value.error } : {}),
  });
}

function defaultCapture(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  input?: Buffer,
  environment?: Readonly<Record<string, string>>,
): ContainerEngineCommandResult {
  const result = spawnSync(executable, [...args], {
    cwd: process.cwd(),
    env: environment ?? containerEngineCommandEnvironment(),
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    ...(input ? { input } : {}),
    timeout: timeoutMs,
  });
  return {
    status: result.status ?? (result.error || result.signal ? 1 : 0),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    ...(result.error ? { error: result.error } : {}),
  };
}

function invokeGuarded(
  guard: ((phase: "before" | "after") => void) | undefined,
  capture: () => ContainerEngineCommandResult,
): ContainerEngineCommandResult {
  guard?.("before");
  let result: ContainerEngineCommandResult | undefined;
  let failure: unknown;
  try {
    result = capture();
  } catch (error) {
    failure = error;
  }
  try {
    guard?.("after");
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
  return normalizedResult(result as ContainerEngineCommandResult);
}

export function createContainerEngineCommand(
  options: ContainerEngineCommandOptions,
): ContainerEngine {
  if (!ENGINE_ID_PATTERN.test(options.engineId)) {
    throw new Error("Container engine identity is invalid.");
  }
  if (!AUTHORITY_ID_PATTERN.test(options.authorityId)) {
    throw new Error("Container engine authority identity is invalid.");
  }
  const endpointAuthorityId = options.endpointAuthorityId ?? options.authorityId;
  if (!AUTHORITY_ID_PATTERN.test(endpointAuthorityId)) {
    throw new Error("Container engine endpoint authority identity is invalid.");
  }
  const executable = normalizedExecutable(options.executable);
  const displayName = boundedText(options.displayName, "Container engine display name");
  const endpointArgs = normalizedArguments(
    options.endpointArgs ?? [],
    "Container engine endpoint arguments",
  );
  const allowedEnvironmentNames = new Set(
    normalizedArguments(
      options.allowedEnvironmentNames ?? [],
      "Container engine environment allowlist",
    ).map((name) => {
      if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
        throw new Error("Container engine environment allowlist contains an invalid name.");
      }
      return name;
    }),
  );
  const commandEnvironment = options.commandEnvironment
    ? replacementCommandEnvironment(options.commandEnvironment, allowedEnvironmentNames)
    : undefined;
  const capture = options.capture ?? defaultCapture;
  const run = (
    args: readonly string[],
    timeoutMs: number,
    endpoint: boolean,
    input?: Buffer,
    environment?: Readonly<Record<string, string>>,
  ) => {
    const normalized = normalizedArguments(args, "Container engine command arguments");
    const commandArgs = endpoint ? [...endpointArgs, ...normalized] : [...normalized];
    if (input !== undefined && (!Buffer.isBuffer(input) || input.length > MAX_INPUT_BYTES)) {
      throw new Error("Container engine command input is invalid or exceeds its byte bound.");
    }
    const boundedTimeout = positiveTimeout(timeoutMs);
    return invokeGuarded(options.guard, () => {
      const selectedEnvironment = environment ?? commandEnvironment;
      if (selectedEnvironment !== undefined) {
        return capture(
          executable,
          commandArgs,
          boundedTimeout,
          input === undefined ? undefined : Buffer.from(input),
          selectedEnvironment,
        );
      }
      return input === undefined
        ? capture(executable, commandArgs, boundedTimeout)
        : capture(executable, commandArgs, boundedTimeout, Buffer.from(input));
    });
  };

  return Object.freeze({
    operation: options.operation,
    engineId: options.engineId,
    displayName,
    authorityId: options.authorityId,
    endpointAuthorityId,
    capture: (args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS, input?: Buffer) =>
      run(args, timeoutMs, true, input),
    ...(options.operation === "host-local-inference"
      ? {
          captureWithEnvironment: (
            args: readonly string[],
            environment: Readonly<Record<string, string>>,
            timeoutMs = DEFAULT_TIMEOUT_MS,
            input?: Buffer,
          ) =>
            run(
              args,
              timeoutMs,
              true,
              input,
              operationCommandEnvironment(environment, allowedEnvironmentNames),
            ),
        }
      : {}),
    captureHost: (args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS) =>
      run(args, timeoutMs, false),
  });
}
