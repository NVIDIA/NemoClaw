// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
  type ContainerEngineOperationScope,
  createContainerEngineCommand,
} from "../../adapters/container-engine";

interface DockerClientBinding {
  readonly endpointArgs: readonly string[];
  readonly executable: string;
  readonly executableIdentitySha256: string;
  readonly commandEnvironmentSha256: string;
  readonly commandEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
  readonly identity: string;
  readonly guard?: () => void;
}

interface DockerExecutableBinding {
  readonly executable: string;
  readonly selectedPath: string;
  readonly identity: string;
  readonly commandEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
  readonly guard: () => void;
}

interface DockerDelegatedCommandBinding {
  readonly identitySha256: string;
  readonly guard: () => void;
}

interface ResolvedDockerContextEndpoint {
  readonly host: string;
  readonly identity: string;
}

export interface DockerOperationAuthority {
  readonly assertAuthority: () => void;
  readonly engine: ContainerEngine;
  readonly spawn: (
    args: readonly string[],
    options?: Parameters<typeof spawn>[2],
  ) => ReturnType<typeof spawn>;
}

const DOCKER_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const DOCKER_HOST_PATTERN = /^(?:npipe|ssh|tcp|unix):\/\/[^\s\u0000-\u001f\u007f]+$/u;
const DOCKER_CREDENTIAL_HELPER_PREFIX = "docker-credential-";
const DOCKER_ARGUMENT_MAX_BYTES = 16 * 1024;
const DOCKER_CONTEXT_INSPECT_FORMAT = "{{json .}}";
const EXECUTABLE_PREFIX_MAX_BYTES = 1024;
const EXECUTABLE_INTERPRETER_MAX_DEPTH = 4;
const bindings = new WeakMap<DockerOperationAuthority, DockerClientBinding>();
const DOCKER_COMMAND_ENV_NAMES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "SSH_AUTH_SOCK",
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
const DOCKER_COMMAND_ENV_PREFIXES = ["LC_", "XDG_"] as const;
const DOCKER_STREAMED_CREDENTIAL_ENV_NAMES = new Set(["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]);
const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024;
const MAX_DOCKER_ARGUMENTS = 512;

function exactDockerValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > DOCKER_ARGUMENT_MAX_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`Docker operation ${label} is invalid.`);
  }
  return value;
}

function absoluteDockerPath(value: string, label: string): string {
  const candidate = exactDockerValue(value, label);
  if (!candidate) throw new Error(`Docker operation ${label} is invalid.`);
  return path.resolve(candidate);
}

function dockerConfigPath(env: NodeJS.ProcessEnv): string {
  const configured = exactDockerValue(env.DOCKER_CONFIG, "DOCKER_CONFIG");
  if (configured) return path.resolve(configured);
  const home = exactDockerValue(env.HOME, "HOME") ?? os.homedir();
  return path.join(path.resolve(home), ".docker");
}

function dockerTlsArgs(env: NodeJS.ProcessEnv): {
  readonly args: readonly string[];
  readonly verify: boolean;
} {
  const tls = exactDockerValue(env.DOCKER_TLS, "DOCKER_TLS") !== undefined;
  const tlsVerify = exactDockerValue(env.DOCKER_TLS_VERIFY, "DOCKER_TLS_VERIFY") !== undefined;
  const certPath = exactDockerValue(env.DOCKER_CERT_PATH, "DOCKER_CERT_PATH");
  const args: string[] = [];
  if (tlsVerify) args.push("--tlsverify");
  else if (tls) args.push("--tls");
  if (certPath) {
    const directory = absoluteDockerPath(certPath, "DOCKER_CERT_PATH");
    args.push(
      "--tlscacert",
      path.join(directory, "ca.pem"),
      "--tlscert",
      path.join(directory, "cert.pem"),
      "--tlskey",
      path.join(directory, "key.pem"),
    );
  }
  return Object.freeze({ args: Object.freeze(args), verify: tlsVerify });
}

function dockerContextName(value: string, label: string): string {
  const context = exactDockerValue(value, label);
  if (!context || !DOCKER_CONTEXT_PATTERN.test(context)) {
    throw new Error(`Docker operation ${label} is invalid.`);
  }
  return context;
}

function dockerHost(value: string): string {
  const host = exactDockerValue(value, "DOCKER_HOST");
  if (!host || !DOCKER_HOST_PATTERN.test(host)) {
    throw new Error("Docker operation DOCKER_HOST is invalid.");
  }
  return host;
}

function requireSecureDockerEndpoint(host: string, tlsVerificationEnabled: boolean): void {
  if (host.startsWith("tcp://") && !tlsVerificationEnabled) {
    throw new Error("Docker operation requires verified TLS for remote Docker TCP endpoints.");
  }
}

function fixedDockerCommandEnvironment(env: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv> {
  const searchPath = exactDockerValue(env.PATH ?? process.env.PATH, "PATH");
  if (!searchPath) throw new Error("Docker operation PATH is unavailable.");
  if (searchPath.split(path.delimiter).some((directory) => !path.isAbsolute(directory))) {
    throw new Error("Docker operation PATH must contain only absolute directories.");
  }
  const source = { ...env, PATH: searchPath };
  const entries = Object.entries(source)
    .filter(
      ([name, value]) =>
        value !== undefined &&
        (DOCKER_COMMAND_ENV_NAMES.has(name) ||
          DOCKER_COMMAND_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(entries));
}

function executableInterpreter(executable: string, status: fs.BigIntStats): string | undefined {
  const descriptor = fs.openSync(
    executable,
    fs.constants.O_RDONLY |
      (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== status.dev || opened.ino !== status.ino) {
      throw new Error("Docker operation executable changed while it was inspected.");
    }
    const prefix = Buffer.alloc(EXECUTABLE_PREFIX_MAX_BYTES);
    const bytesRead = fs.readSync(descriptor, prefix, 0, prefix.length, 0);
    if (bytesRead < 2 || prefix[0] !== 0x23 || prefix[1] !== 0x21) return undefined;
    const newline = prefix.subarray(0, bytesRead).indexOf(0x0a, 2);
    if (newline < 0) {
      throw new Error("Docker operation executable interpreter line is invalid.");
    }
    const line = prefix.subarray(2, newline).toString("utf8").trim();
    const interpreter = line.split(/\s+/u)[0];
    if (!interpreter || !path.isAbsolute(interpreter)) {
      throw new Error("Docker operation executable interpreter must be absolute.");
    }
    const resolved = fs.realpathSync(interpreter);
    if (path.basename(interpreter) === "env" || path.basename(resolved) === "env") {
      throw new Error("Docker operation executable cannot delegate through env.");
    }
    return interpreter;
  } finally {
    fs.closeSync(descriptor);
  }
}

function qualifiedExecutableMetadata(
  selectedPath: string,
  executable: string,
  depth = 0,
  ancestors: ReadonlySet<string> = new Set(),
): Readonly<Record<string, unknown>> {
  if (depth > EXECUTABLE_INTERPRETER_MAX_DEPTH || ancestors.has(executable)) {
    throw new Error("Docker operation executable interpreter chain is invalid.");
  }
  const selected = fs.lstatSync(selectedPath, { bigint: true });
  const target = fs.statSync(executable, { bigint: true });
  if (!target.isFile()) throw new Error("Docker operation executable is not one regular file.");
  fs.accessSync(executable, fs.constants.X_OK);
  const interpreterPath = executableInterpreter(executable, target);
  const interpreter =
    interpreterPath === undefined
      ? undefined
      : qualifiedExecutableMetadata(
          interpreterPath,
          fs.realpathSync(interpreterPath),
          depth + 1,
          new Set([...ancestors, executable]),
        );
  return Object.freeze({
    selectedPath,
    executable,
    selectedDev: selected.dev.toString(),
    selectedIno: selected.ino.toString(),
    selectedMode: selected.mode.toString(),
    selectedSize: selected.size.toString(),
    selectedMtimeNs: selected.mtimeNs.toString(),
    selectedCtimeNs: selected.ctimeNs.toString(),
    targetDev: target.dev.toString(),
    targetIno: target.ino.toString(),
    targetMode: target.mode.toString(),
    targetUid: target.uid.toString(),
    targetGid: target.gid.toString(),
    targetSize: target.size.toString(),
    targetMtimeNs: target.mtimeNs.toString(),
    targetCtimeNs: target.ctimeNs.toString(),
    ...(interpreter === undefined ? {} : { interpreter }),
  });
}

function dockerExecutableMetadata(selectedPath: string, executable: string): string {
  return JSON.stringify(qualifiedExecutableMetadata(selectedPath, executable));
}

function executableCandidate(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function dockerDelegatedCommandSnapshot(searchPath: string, requireSsh: boolean): string {
  const selected = new Map<string, string>();
  for (const directory of searchPath.split(path.delimiter)) {
    if (requireSsh && !selected.has("ssh")) {
      const candidate = path.join(directory, "ssh");
      if (executableCandidate(candidate)) selected.set("ssh", candidate);
    }
    let names: readonly string[];
    try {
      names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new Error("Docker operation could not inspect its delegated command path.");
    }
    for (const name of names) {
      if (
        !name.startsWith(DOCKER_CREDENTIAL_HELPER_PREFIX) ||
        name.length === DOCKER_CREDENTIAL_HELPER_PREFIX.length ||
        selected.has(name)
      ) {
        continue;
      }
      const candidate = path.join(directory, name);
      if (executableCandidate(candidate)) selected.set(name, candidate);
    }
  }
  if (requireSsh && !selected.has("ssh")) {
    throw new Error("Docker operation could not resolve one absolute SSH executable.");
  }
  return JSON.stringify(
    [...selected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, selectedPath]) => ({
        name,
        metadata: qualifiedExecutableMetadata(selectedPath, fs.realpathSync(selectedPath)),
      })),
  );
}

function qualifyDockerDelegatedCommands(
  commandEnvironment: Readonly<NodeJS.ProcessEnv>,
  endpointHost: string,
): DockerDelegatedCommandBinding {
  const searchPath = commandEnvironment.PATH as string;
  const requireSsh = endpointHost.startsWith("ssh://");
  const snapshot = dockerDelegatedCommandSnapshot(searchPath, requireSsh);
  return Object.freeze({
    identitySha256: createHash("sha256").update(snapshot).digest("hex"),
    guard: () => {
      let current: string;
      try {
        current = dockerDelegatedCommandSnapshot(searchPath, requireSsh);
      } catch {
        throw new Error("Docker operation delegated command set changed after qualification.");
      }
      if (current !== snapshot) {
        throw new Error("Docker operation delegated command set changed after qualification.");
      }
    },
  });
}

function dockerCommandEnvironmentSha256(
  operation: ContainerEngineOperationScope,
  commandEnvironment: Readonly<NodeJS.ProcessEnv>,
  endpointHost: string,
  delegatedCommands: DockerDelegatedCommandBinding,
): string {
  const authorityEnvironment = Object.fromEntries(
    Object.entries(commandEnvironment).filter(([name]) => name !== "PATH"),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        authorityEnvironment,
        delegatedCommandsSha256: delegatedCommands.identitySha256,
        ...(operation === "host-local-inference" || endpointHost.startsWith("ssh://")
          ? { delegatedCommandSearchPath: commandEnvironment.PATH }
          : {}),
      }),
    )
    .digest("hex");
}

function qualifyDockerExecutable(env: NodeJS.ProcessEnv): DockerExecutableBinding {
  const commandEnvironment = fixedDockerCommandEnvironment(env);
  const searchPath = commandEnvironment.PATH as string;
  let selectedPath: string | null = null;
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "docker");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      selectedPath = candidate;
      break;
    } catch {
      // Continue through the fixed absolute search path.
    }
  }
  if (selectedPath === null) {
    throw new Error("Docker operation could not resolve one absolute Docker executable.");
  }
  const executable = fs.realpathSync(selectedPath);
  const metadata = dockerExecutableMetadata(selectedPath, executable);
  const identity = createHash("sha256").update(metadata).digest("hex");
  const cwd = path.dirname(executable);
  return Object.freeze({
    executable,
    selectedPath,
    identity,
    commandEnvironment,
    cwd,
    guard: () => {
      let currentExecutable: string;
      let currentMetadata: string;
      try {
        currentExecutable = fs.realpathSync(selectedPath as string);
        currentMetadata = dockerExecutableMetadata(selectedPath as string, currentExecutable);
      } catch {
        throw new Error("Docker operation executable changed after qualification.");
      }
      if (currentExecutable !== executable || currentMetadata !== metadata) {
        throw new Error("Docker operation executable changed after qualification.");
      }
    },
  });
}

function fixedDockerCapture(executable: DockerExecutableBinding): ContainerEngineCommandCapture {
  return (_executable, args, timeoutMs, input) => {
    const result = spawnSync(executable.executable, [...args], {
      cwd: executable.cwd,
      env: { ...executable.commandEnvironment },
      encoding: "utf8",
      maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
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
  };
}

function fixedDockerSpawnArguments(args: readonly string[]): readonly string[] {
  if (!Array.isArray(args) || args.length > MAX_DOCKER_ARGUMENTS) {
    throw new Error("Docker operation has too many command arguments.");
  }
  return Object.freeze(
    args.map((value, index) => {
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > DOCKER_ARGUMENT_MAX_BYTES
      ) {
        throw new Error(`Docker operation command argument ${String(index)} is invalid.`);
      }
      return value;
    }),
  );
}

function fixedDockerSpawnEnvironment(
  args: readonly string[],
  commandEnvironment: Readonly<NodeJS.ProcessEnv>,
  callerEnvironment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const environment = { ...commandEnvironment };
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-e" && args[index] !== "--env") continue;
    const name = args[index + 1];
    if (!name || !DOCKER_STREAMED_CREDENTIAL_ENV_NAMES.has(name)) continue;
    const value = callerEnvironment?.[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function dockerBindingProbe(
  operation: ContainerEngineOperationScope,
  endpointArgs: readonly string[],
  executable: DockerExecutableBinding,
  capture: ContainerEngineCommandCapture,
): ContainerEngine {
  return createContainerEngineCommand({
    operation,
    engineId: "docker",
    displayName: "Docker",
    authorityId: "docker:qualification",
    executable: executable.executable,
    endpointArgs,
    capture,
    guard: executable.guard,
  });
}

function requireDockerProbeOutput(
  result: ReturnType<ContainerEngine["capture"]>,
  label: string,
): string {
  if (result.error || result.status !== 0) {
    throw new Error(`Docker operation could not ${label}.`);
  }
  const output = result.stdout.trim();
  if (!output) throw new Error(`Docker operation could not ${label}.`);
  return output;
}

function resolvedDockerContextEndpoint(
  probe: ContainerEngine,
  context: string,
): ResolvedDockerContextEndpoint {
  const output = requireDockerProbeOutput(
    probe.capture(["context", "inspect", context, "--format", DOCKER_CONTEXT_INSPECT_FORMAT]),
    "qualify the Docker context endpoint",
  );
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(output);
  } catch {
    throw new Error("Docker operation Docker context endpoint is unreadable.");
  }
  if (typeof endpoint !== "object" || endpoint === null) {
    throw new Error("Docker operation Docker context endpoint is invalid.");
  }
  const inspection = endpoint as {
    Endpoints?: { docker?: { Host?: unknown; SkipTLSVerify?: unknown } };
    TLSMaterial?: { docker?: unknown };
  };
  const dockerEndpoint = inspection.Endpoints?.docker;
  if (
    typeof dockerEndpoint?.Host !== "string" ||
    typeof dockerEndpoint.SkipTLSVerify !== "boolean"
  ) {
    throw new Error("Docker operation Docker context endpoint is invalid.");
  }
  const host = dockerHost(dockerEndpoint.Host);
  const tlsMaterial = inspection.TLSMaterial?.docker ?? [];
  if (
    !Array.isArray(tlsMaterial) ||
    tlsMaterial.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9._-]+$/u.test(entry))
  ) {
    throw new Error("Docker operation Docker context TLS material is invalid.");
  }
  const tlsFiles = [...tlsMaterial].sort();
  requireSecureDockerEndpoint(host, !dockerEndpoint.SkipTLSVerify && tlsFiles.includes("ca.pem"));
  return Object.freeze({
    host,
    identity: JSON.stringify({
      host,
      skipTlsVerify: dockerEndpoint.SkipTLSVerify,
      tlsMaterial: tlsFiles,
    }),
  });
}

function qualifiedDockerClientBinding(
  operation: ContainerEngineOperationScope,
  endpointArgs: readonly string[],
  endpointHost: string,
  endpointIdentity: string,
  executable: DockerExecutableBinding,
  endpointGuard?: () => void,
): DockerClientBinding {
  const delegatedCommands = qualifyDockerDelegatedCommands(
    executable.commandEnvironment,
    endpointHost,
  );
  const commandEnvironmentSha256 = dockerCommandEnvironmentSha256(
    operation,
    executable.commandEnvironment,
    endpointHost,
    delegatedCommands,
  );
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        endpointArgs,
        endpointIdentity,
        executableIdentitySha256: executable.identity,
        commandEnvironmentSha256,
        cwd: executable.cwd,
      }),
    )
    .digest("hex");
  return Object.freeze({
    endpointArgs,
    executable: executable.executable,
    executableIdentitySha256: executable.identity,
    commandEnvironmentSha256,
    commandEnvironment: executable.commandEnvironment,
    cwd: executable.cwd,
    identity,
    guard: () => {
      executable.guard();
      delegatedCommands.guard();
      endpointGuard?.();
    },
  });
}

function dockerClientBinding(
  operation: ContainerEngineOperationScope,
  env: NodeJS.ProcessEnv,
  executable: DockerExecutableBinding,
  capture: ContainerEngineCommandCapture,
): DockerClientBinding {
  const configArgs = ["--config", dockerConfigPath(env)] as const;
  const tls = dockerTlsArgs(env);
  const explicitContext = exactDockerValue(env.DOCKER_CONTEXT, "DOCKER_CONTEXT");
  const explicitHost = exactDockerValue(env.DOCKER_HOST, "DOCKER_HOST");
  if (!explicitContext && explicitHost) {
    const host = dockerHost(explicitHost);
    requireSecureDockerEndpoint(host, tls.verify);
    const endpointArgs = Object.freeze([...configArgs, "--host", host, ...tls.args]);
    return qualifiedDockerClientBinding(operation, endpointArgs, host, host, executable);
  }

  let context: string;
  if (explicitContext) {
    context = dockerContextName(explicitContext, "DOCKER_CONTEXT");
  } else {
    const selectorProbe = dockerBindingProbe(
      operation,
      [...configArgs, ...tls.args],
      executable,
      capture,
    );
    context = dockerContextName(
      requireDockerProbeOutput(
        selectorProbe.capture(["context", "show"]),
        "resolve the Docker context",
      ),
      "current Docker context",
    );
  }
  const endpointArgs = Object.freeze([...configArgs, "--context", context, ...tls.args]);
  const endpointProbe = dockerBindingProbe(operation, endpointArgs, executable, capture);
  const qualifiedEndpoint = resolvedDockerContextEndpoint(endpointProbe, context);
  return qualifiedDockerClientBinding(
    operation,
    endpointArgs,
    qualifiedEndpoint.host,
    qualifiedEndpoint.identity,
    executable,
    () => {
      if (
        resolvedDockerContextEndpoint(endpointProbe, context).identity !==
        qualifiedEndpoint.identity
      ) {
        throw new Error(
          "Docker context endpoint changed after qualification; retry the operation.",
        );
      }
    },
  );
}

/** Bind one container-engine operation to fixed, qualified Docker client endpoint arguments. */
export function createDockerOperationAuthority(
  operation: ContainerEngineOperationScope,
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
): DockerOperationAuthority {
  const executable = qualifyDockerExecutable(env);
  const commandCapture = capture ?? fixedDockerCapture(executable);
  const binding = dockerClientBinding(operation, env, executable, commandCapture);
  const assertAuthority = () => binding.guard?.();
  const engine = createContainerEngineCommand({
    operation,
    engineId: "docker",
    displayName: "Docker",
    authorityId: `docker:${binding.identity}`,
    executable: binding.executable,
    endpointArgs: binding.endpointArgs,
    capture: commandCapture,
    ...(binding.guard ? { guard: binding.guard } : {}),
  });
  const authority = Object.freeze({
    assertAuthority,
    engine,
    spawn: (args: readonly string[], options?: Parameters<typeof spawn>[2]) => {
      assertAuthority();
      const normalized = fixedDockerSpawnArguments(args);
      return spawn(binding.executable, [...binding.endpointArgs, ...normalized], {
        ...options,
        cwd: binding.cwd,
        env: fixedDockerSpawnEnvironment(normalized, binding.commandEnvironment, options?.env),
        shell: false,
      });
    },
  });
  bindings.set(authority, binding);
  return authority;
}

/** Prefix streamed Docker commands with the endpoint owned by this qualified authority. */
export function dockerOperationCommandArguments(
  authority: DockerOperationAuthority,
  args: readonly string[],
): readonly string[] {
  const binding = bindings.get(authority);
  if (!binding) {
    throw new Error("Docker operation authority does not own this command binding.");
  }
  return Object.freeze([...binding.endpointArgs, ...args]);
}

/** Stable digest for the executable and exact endpoint authority of one Docker operation. */
export function dockerOperationBindingSha256(engine: ContainerEngine): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: engine.operation,
        engineId: engine.engineId,
        authorityId: engine.authorityId,
      }),
    )
    .digest("hex");
}
