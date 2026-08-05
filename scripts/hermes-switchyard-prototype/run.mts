// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";

export const HERMES_SWITCHYARD_PROTOTYPE = Object.freeze({
  relayRevision: "44438179c37cfb214901fd80c126605e075f3935",
  relayPullRef: "refs/pull/586/head",
  switchyardRevision: "aa0a31126cc7ca922a6acdf4f1ef656744698c6c",
  rustBuilder:
    "rust:1.96.1-trixie@sha256:1f0dbad1df66647807e6952d1db85d0b2bda7606cb2139d82517e4f009967376",
  hermesImage:
    "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:c4899e00817acb3421037efba013c720a79895bc8c4448b47aa9aca0def3104b",
  hermesVersion: "0.19.0",
  relayRepository: "https://github.com/NVIDIA/NeMo-Relay.git",
  providerAuthorization: "Bearer nemoclaw-prototype-provider-sentinel",
  clientApiKey: "nemoclaw-prototype-client-sentinel",
});

const ASSET_NAMES = [
  ".dockerignore",
  "Dockerfile",
  "classifier-plugins.toml",
  "fake-provider.py",
  "run.sh",
  "verify.py",
] as const;
export const PROTOTYPE_ARTIFACT_NAMES = [
  "classifier-plugins.toml",
  "fake-provider.py",
  "nemo-relay",
  "relay-revision",
  "run.sh",
  "verify.py",
] as const;
const RESULT_PREFIX = "NEMOCLAW_HERMES_SWITCHYARD_PROTOTYPE=";
const TEMP_PREFIX = "nemoclaw-hermes-switchyard-prototype-";
const RELAY_CACHE_DIRECTORY = "nemoclaw-hermes-switchyard-relay-cache";
export const RELAY_FETCH_TIMEOUT_MS = 10 * 60 * 1_000;
export const RELAY_VALIDATION_TIMEOUT_MS = 2 * 60 * 1_000;
const SWITCHYARD_PACKAGES = [
  "switchyard-libsy",
  "switchyard-protocol",
  "switchyard-translation",
] as const;

type PrototypeResult = {
  readonly status: "pass";
  readonly [key: string]: unknown;
};

export type PrototypeArtifact = {
  readonly directory: string;
  readonly relayBinarySha256: string;
};

type CleanupState = {
  containerName?: string;
  imageTag?: string;
  tempRoot?: string;
};

type SupervisionState = {
  activeChild?: ChildProcess;
  interrupted?: NodeJS.Signals;
  terminationGraceMs?: number;
};

const terminationPromises = new WeakMap<ChildProcess, Promise<void>>();

type CargoLock = {
  readonly package?: ReadonlyArray<{
    readonly name?: unknown;
    readonly source?: unknown;
  }>;
};

type CargoManifest = {
  readonly workspace?: {
    readonly dependencies?: Record<
      string,
      {
        readonly git?: unknown;
        readonly rev?: unknown;
      }
    >;
  };
};

type PrototypeTarget = {
  readonly base_url?: unknown;
  readonly endpoint?: unknown;
  readonly header_env?: unknown;
  readonly protocol?: unknown;
};

type PrototypePluginConfig = {
  readonly components?: ReadonlyArray<{
    readonly config?: {
      readonly algorithm?: {
        readonly classifier_target?: unknown;
        readonly kind?: unknown;
        readonly strong_target?: unknown;
        readonly weak_target?: unknown;
      };
      readonly default_targets?: Record<string, unknown>;
      readonly max_retries?: unknown;
      readonly targets?: Record<string, PrototypeTarget>;
    };
    readonly kind?: unknown;
  }>;
};

class PrototypeInterruptedError extends Error {
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals) {
    super(`Prototype interrupted by ${signal}`);
    this.name = "PrototypeInterruptedError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

function runCapture(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30_000,
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with ${result.status ?? "no status"}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}

function terminateChild(child: ChildProcess, graceMs = 5_000): Promise<void> {
  const existing = terminationPromises.get(child);
  if (existing) {
    return existing;
  }
  const termination = new Promise<void>((resolve) => {
    try {
      signalChildTree(child, "SIGTERM");
    } catch {
      // The five-second escalation below still retries the exact process group.
    }
    setTimeout(() => {
      try {
        signalChildTree(child, "SIGKILL");
      } catch {
        // A missing process group means termination already succeeded.
      }
      resolve();
    }, graceMs);
  });
  terminationPromises.set(child, termination);
  return termination;
}

function throwIfInterrupted(supervision: SupervisionState): void {
  if (supervision.interrupted) {
    throw new PrototypeInterruptedError(supervision.interrupted);
  }
}

function runSupervised(
  command: string,
  args: string[],
  supervision: SupervisionState,
  options: {
    capture?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<{ stderr: string; stdout: string }> {
  throwIfInterrupted(supervision);
  return new Promise((resolve, reject) => {
    const capture = options.capture === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    supervision.activeChild = child;
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;

    const terminateWith = (error: Error) => {
      failure ??= error;
      void terminateChild(child, supervision.terminationGraceMs);
    };
    const timeout = setTimeout(
      () => terminateWith(new Error(`${command} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) {
        terminateWith(new Error(`${command} stdout exceeded 16 MiB`));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024 * 1024) {
        terminateWith(new Error(`${command} stderr exceeded 16 MiB`));
      }
    });
    child.once("error", (error) => terminateWith(error));
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      if (supervision.activeChild === child) {
        supervision.activeChild = undefined;
      }
      const termination = terminationPromises.get(child);
      if (termination) {
        await termination;
      }
      if (supervision.interrupted) {
        reject(new PrototypeInterruptedError(supervision.interrupted));
      } else if (failure) {
        reject(failure);
      } else if (code !== 0) {
        const detail = (stderr || stdout).trim();
        reject(
          new Error(
            `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}${
              detail ? `: ${detail}` : ""
            }`,
          ),
        );
      } else {
        resolve({ stderr, stdout });
      }
    });
  });
}

export function runSupervisedCommandForTest(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stderr: string; stdout: string }> {
  return runSupervised(command, args, { terminationGraceMs: 25 }, { capture: true, timeoutMs });
}

function publicGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ASKPASS: "/usr/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function validateRelayIdentity(input: {
  readonly cargoLock: string;
  readonly cargoToml: string;
  readonly head: string;
}): void {
  if (input.head !== HERMES_SWITCHYARD_PROTOTYPE.relayRevision) {
    throw new Error(
      `Relay identity mismatch: expected ${HERMES_SWITCHYARD_PROTOTYPE.relayRevision}, got ${input.head}`,
    );
  }

  const cargoLock = parseToml(input.cargoLock) as CargoLock;
  const cargoManifest = parseToml(input.cargoToml) as CargoManifest;
  let switchyardSource: string | undefined;
  for (const packageName of SWITCHYARD_PACKAGES) {
    const manifestDependency = cargoManifest.workspace?.dependencies?.[packageName];
    if (
      manifestDependency?.rev !== HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision ||
      typeof manifestDependency.git !== "string"
    ) {
      throw new Error(`Relay ${packageName} manifest pin does not match the prototype contract`);
    }
    const sourceUrl = new URL(manifestDependency.git);
    if (sourceUrl.protocol !== "https:" || !sourceUrl.pathname.endsWith("/Switchyard.git")) {
      throw new Error(`Relay ${packageName} manifest source is not an HTTPS Switchyard repository`);
    }
    switchyardSource ??= manifestDependency.git;
    if (manifestDependency.git !== switchyardSource) {
      throw new Error("Relay Switchyard crates do not share one locked source");
    }

    const lockPackage = cargoLock.package?.find((candidate) => candidate.name === packageName);
    const expectedSource = `git+${switchyardSource}?rev=${HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision}#${HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision}`;
    if (!lockPackage || lockPackage.source !== expectedSource) {
      throw new Error(`Relay ${packageName} lockfile pin does not match the prototype contract`);
    }
  }
}

export function buildRuntimeDockerArgs(imageTag: string, containerName: string): string[] {
  return [
    "run",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--user",
    "sandbox:sandbox",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "256",
    "--memory",
    "1g",
    "--cpus",
    "1",
    "--ulimit",
    "nofile=1024:1024",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
    "--env",
    `OPENAI_API_KEY=${HERMES_SWITCHYARD_PROTOTYPE.clientApiKey}`,
    "--env",
    `PROTOTYPE_PROVIDER_AUTHORIZATION=${HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization}`,
    "--env",
    "HOME=/tmp/hermes-user",
    "--env",
    "HERMES_HOME=/tmp/hermes-source",
    "--env",
    "PYTHONDONTWRITEBYTECODE=1",
    "--env",
    "XDG_CACHE_HOME=/tmp/cache",
    imageTag,
  ];
}

export function parsePrototypeResult(stdout: string, stderr: string): PrototypeResult {
  for (const forbidden of [
    HERMES_SWITCHYARD_PROTOTYPE.clientApiKey,
    HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization,
  ]) {
    if (stdout.includes(forbidden) || stderr.includes(forbidden)) {
      throw new Error("Prototype output exposed a credential sentinel");
    }
  }

  const resultLines = stdout.split(/\r?\n/).filter((line) => line.startsWith(RESULT_PREFIX));
  if (resultLines.length !== 1) {
    throw new Error(`Expected one prototype result, found ${resultLines.length}`);
  }

  const parsed = JSON.parse(resultLines[0].slice(RESULT_PREFIX.length)) as PrototypeResult;
  if (parsed.status !== "pass") {
    throw new Error("Hermes Switchyard prototype did not report a passing result");
  }
  return parsed;
}

export function isOwnedPrototypeTempRoot(candidate: string): boolean {
  try {
    const realCandidate = realpathSync(candidate);
    const realTemp = realpathSync(tmpdir());
    return (
      dirname(realCandidate) === realTemp &&
      basename(realCandidate).startsWith(TEMP_PREFIX) &&
      basename(realCandidate).length > TEMP_PREFIX.length
    );
  } catch {
    return false;
  }
}

function prototypeAssetRoot(): string {
  return fileURLToPath(new URL("./", import.meta.url));
}

export function validateTrackedPrototypeAssets(): {
  readonly router: "llm_classifier";
  readonly targetCount: 3;
} {
  const assetRoot = prototypeAssetRoot();
  const dockerfile = readFileSync(join(assetRoot, "Dockerfile"), "utf8");
  const configRaw = readFileSync(join(assetRoot, "classifier-plugins.toml"), "utf8");
  for (const expected of [
    `FROM ${HERMES_SWITCHYARD_PROTOTYPE.rustBuilder}`,
    `FROM ${HERMES_SWITCHYARD_PROTOTYPE.hermesImage}`,
    "cargo fetch --locked",
    "RUN --network=none",
    "cargo build --frozen --release -p nemo-relay-cli --features switchyard",
    HERMES_SWITCHYARD_PROTOTYPE.relayRevision,
    HERMES_SWITCHYARD_PROTOTYPE.relayPullRef,
    HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision,
  ]) {
    if (!dockerfile.includes(expected)) {
      throw new Error(`Prototype Dockerfile is missing reviewed contract value ${expected}`);
    }
  }
  for (const forbidden of [
    HERMES_SWITCHYARD_PROTOTYPE.clientApiKey,
    HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization,
  ]) {
    if (dockerfile.includes(forbidden) || configRaw.includes(forbidden)) {
      throw new Error("Tracked prototype assets contain a credential sentinel");
    }
  }

  const config = parseToml(configRaw) as PrototypePluginConfig;
  const switchyard = config.components?.find((component) => component.kind === "switchyard");
  if (!switchyard?.config || switchyard.config.max_retries !== 2) {
    throw new Error("Prototype Switchyard retry contract is missing or unbounded");
  }
  if (switchyard.config.default_targets?.openai_chat !== "quality") {
    throw new Error("Prototype Switchyard fallback target is not quality");
  }
  const algorithm = switchyard.config.algorithm;
  if (
    algorithm?.kind !== "llm_classifier" ||
    algorithm.classifier_target !== "classifier" ||
    algorithm.weak_target !== "fast" ||
    algorithm.strong_target !== "quality"
  ) {
    throw new Error("Prototype Switchyard classifier bindings do not match the reviewed contract");
  }
  const targetNames = Object.keys(switchyard.config.targets ?? {}).sort();
  if (JSON.stringify(targetNames) !== JSON.stringify(["classifier", "fast", "quality"])) {
    throw new Error(`Prototype has unexpected Switchyard targets: ${targetNames.join(", ")}`);
  }
  const targets = Object.values(switchyard.config.targets ?? {});
  if (targets.length !== 3) {
    throw new Error(`Prototype expected 3 Switchyard targets, found ${targets.length}`);
  }
  for (const target of targets) {
    if (
      target.base_url !== "http://127.0.0.1:4101" ||
      target.endpoint !== "/v1/chat/completions" ||
      target.protocol !== "openai_chat" ||
      JSON.stringify(target.header_env) !==
        JSON.stringify({ authorization: "PROTOTYPE_PROVIDER_AUTHORIZATION" })
    ) {
      throw new Error("Prototype target escaped its loopback protocol and credential contract");
    }
  }
  return { router: "llm_classifier", targetCount: 3 };
}

function validateRelayCheckout(relay: string, description: string): void {
  validateRelayIdentity({
    cargoLock: readFileSync(join(relay, "Cargo.lock"), "utf8"),
    cargoToml: readFileSync(join(relay, "Cargo.toml"), "utf8"),
    head: runCapture("git", ["rev-parse", "HEAD"], {
      cwd: relay,
      env: publicGitEnvironment(),
      timeoutMs: RELAY_VALIDATION_TIMEOUT_MS,
    }),
  });
  if (
    runCapture("git", ["status", "--porcelain"], {
      cwd: relay,
      env: publicGitEnvironment(),
      timeoutMs: RELAY_VALIDATION_TIMEOUT_MS,
    }) !== ""
  ) {
    throw new Error(`${description} Relay prototype checkout is unexpectedly dirty`);
  }
}

function relaySourceCacheParent(): string {
  const parent = join(tmpdir(), RELAY_CACHE_DIRECTORY);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(parent);
  if (dirname(realParent) !== realpathSync(tmpdir())) {
    throw new Error(`Relay source cache escaped the private temporary directory: ${realParent}`);
  }
  return realParent;
}

export function relaySourceCachePath(): string {
  return join(relaySourceCacheParent(), HERMES_SWITCHYARD_PROTOTYPE.relayRevision);
}

export function copyRelaySourceForBuild(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

async function prepareRelaySourceCache(supervision: SupervisionState): Promise<string> {
  const cache = relaySourceCachePath();
  if (existsSync(cache)) {
    validateRelayCheckout(cache, "Cached");
    console.log("[prototype] Reusing the verified pinned Relay source cache");
    return cache;
  }

  const candidate = mkdtempSync(join(relaySourceCacheParent(), "candidate-"));
  chmodSync(candidate, 0o700);
  try {
    runCapture("git", ["init", candidate], { env: publicGitEnvironment() });
    runCapture("git", ["remote", "add", "origin", HERMES_SWITCHYARD_PROTOTYPE.relayRepository], {
      cwd: candidate,
      env: publicGitEnvironment(),
    });
    console.log("[prototype] Downloading the pinned Relay source; this is cached after validation");
    await runSupervised(
      "git",
      [
        "fetch",
        "--depth=1",
        "--no-tags",
        "--progress",
        "origin",
        HERMES_SWITCHYARD_PROTOTYPE.relayRevision,
      ],
      supervision,
      {
        cwd: candidate,
        env: publicGitEnvironment(),
        timeoutMs: RELAY_FETCH_TIMEOUT_MS,
      },
    );
    throwIfInterrupted(supervision);
    runCapture("git", ["checkout", "--detach", "FETCH_HEAD"], {
      cwd: candidate,
      env: publicGitEnvironment(),
    });
    validateRelayCheckout(candidate, "Downloaded");
    renameSync(candidate, cache);
    return cache;
  } catch (error) {
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true, recursive: true });
    }
    throw error;
  }
}

async function stageBuildContext(tempRoot: string, supervision: SupervisionState): Promise<string> {
  const context = join(tempRoot, "build-context");
  const relay = join(context, "relay");
  const prototypeAssets = join(context, "prototype");
  mkdirSync(context, { recursive: true, mode: 0o700 });

  const cachedRelay = await prepareRelaySourceCache(supervision);
  copyRelaySourceForBuild(cachedRelay, relay);
  validateRelayCheckout(relay, "Staged");

  const assetRoot = prototypeAssetRoot();
  validateTrackedPrototypeAssets();
  mkdirSync(prototypeAssets, { recursive: true, mode: 0o700 });
  for (const asset of ASSET_NAMES) {
    const destination =
      asset === "Dockerfile" || asset === ".dockerignore"
        ? join(context, asset)
        : join(prototypeAssets, asset);
    copyFileSync(join(assetRoot, asset), destination);
  }
  writeFileSync(
    join(prototypeAssets, "relay-revision"),
    `${HERMES_SWITCHYARD_PROTOTYPE.relayRevision}\n`,
    { mode: 0o600 },
  );
  return context;
}

function runDockerCleanup(args: string[], dockerEnv: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: dockerEnv,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) {
    return result.error.message;
  }
  if (result.status === 0) {
    return undefined;
  }
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (output.includes("No such container") || output.includes("No such image")) {
    return undefined;
  }
  return output;
}

function cleanExactContainer(name: string, dockerEnv: NodeJS.ProcessEnv): string | undefined {
  const stopError = runDockerCleanup(["stop", "--time", "5", name], dockerEnv);
  const removeError = runDockerCleanup(["rm", "--force", name], dockerEnv);
  if (removeError) {
    return `failed to remove exact container ${name}: ${removeError}`;
  }
  if (stopError && !stopError.includes("is not running")) {
    return `failed to stop exact container ${name}: ${stopError}`;
  }
  return undefined;
}

function cleanExactImage(name: string, dockerEnv: NodeJS.ProcessEnv): string | undefined {
  const error = runDockerCleanup(["image", "rm", "--force", name], dockerEnv);
  return error ? `failed to remove exact image ${name}: ${error}` : undefined;
}

function cleanup(state: CleanupState, dockerEnv: NodeJS.ProcessEnv): string[] {
  const errors: string[] = [];
  if (state.containerName) {
    const error = cleanExactContainer(state.containerName, dockerEnv);
    if (error) errors.push(error);
  }
  if (state.imageTag) {
    const error = cleanExactImage(state.imageTag, dockerEnv);
    if (error) errors.push(error);
  }
  if (state.tempRoot) {
    if (isOwnedPrototypeTempRoot(state.tempRoot)) {
      try {
        rmSync(state.tempRoot, { force: true, recursive: true });
      } catch (error) {
        errors.push(
          `failed to remove prototype temporary root ${state.tempRoot}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      errors.push(`refused to remove unowned temporary path ${state.tempRoot}`);
    }
  }
  return errors;
}

export async function exportPrototypeArtifactBundle(
  destination: string,
  dockerEnv: NodeJS.ProcessEnv = process.env,
): Promise<PrototypeArtifact> {
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("The Hermes Switchyard prototype requires Docker on macOS or Linux");
  }
  if (!isAbsolute(destination)) {
    throw new Error("Prototype artifact destination must be an absolute path");
  }
  if (existsSync(destination)) {
    throw new Error(`Prototype artifact destination already exists: ${destination}`);
  }
  realpathSync(dirname(destination));
  runCapture("docker", ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv });
  runCapture("git", ["--version"]);

  const state: CleanupState = {};
  const supervision: SupervisionState = {};
  const suffix = `${process.pid}-${randomUUID().slice(0, 12)}`;
  state.imageTag = `nemoclaw-hermes-switchyard-artifact:${suffix}`;
  state.containerName = `nemoclaw-hermes-switchyard-artifact-${suffix}`;
  state.tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  chmodSync(state.tempRoot, 0o700);

  let artifact: PrototypeArtifact | undefined;
  let primaryError: unknown;
  const onInterrupt = () => {
    supervision.interrupted = "SIGINT";
    if (supervision.activeChild) {
      void terminateChild(supervision.activeChild, supervision.terminationGraceMs);
    }
  };
  const onTerminate = () => {
    supervision.interrupted = "SIGTERM";
    if (supervision.activeChild) {
      void terminateChild(supervision.activeChild, supervision.terminationGraceMs);
    }
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    console.log("[prototype] Preparing the verified pinned Relay source");
    const context = await stageBuildContext(state.tempRoot, supervision);
    console.log("[prototype] Building the managed-sandbox artifact bundle");
    await runSupervised(
      "docker",
      ["build", "--progress=plain", "--tag", state.imageTag, context],
      supervision,
      { env: dockerEnv, timeoutMs: 30 * 60 * 1_000 },
    );
    throwIfInterrupted(supervision);

    mkdirSync(destination, { mode: 0o700 });
    runCapture("docker", ["create", "--name", state.containerName, state.imageTag], {
      env: dockerEnv,
      timeoutMs: 60_000,
    });
    runCapture("docker", ["cp", `${state.containerName}:/opt/nemoclaw-prototype/.`, destination], {
      env: dockerEnv,
      timeoutMs: 120_000,
    });

    const entries = readdirSync(destination).sort();
    if (JSON.stringify(entries) !== JSON.stringify([...PROTOTYPE_ARTIFACT_NAMES].sort())) {
      throw new Error(`Prototype artifact bundle has unexpected entries: ${entries.join(", ")}`);
    }
    const revision = readFileSync(join(destination, "relay-revision"), "utf8").trim();
    if (revision !== HERMES_SWITCHYARD_PROTOTYPE.relayRevision) {
      throw new Error(`Exported Relay revision mismatch: ${revision}`);
    }
    for (const executable of ["fake-provider.py", "nemo-relay", "run.sh", "verify.py"]) {
      chmodSync(join(destination, executable), 0o555);
    }
    for (const dataFile of ["classifier-plugins.toml", "relay-revision"]) {
      chmodSync(join(destination, dataFile), 0o444);
    }
    const relayBinarySha256 = createHash("sha256")
      .update(readFileSync(join(destination, "nemo-relay")))
      .digest("hex");
    artifact = {
      directory: realpathSync(destination),
      relayBinarySha256,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }

  const cleanupErrors = cleanup(state, dockerEnv);
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new Error(
        `${primaryError instanceof Error ? primaryError.message : String(primaryError)}\nCleanup also failed:\n${cleanupErrors.join("\n")}`,
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join("\n"));
  }
  if (!artifact) {
    throw new Error("Prototype artifact export completed without a result");
  }
  return artifact;
}

export async function runHermesSwitchyardPrototype(): Promise<PrototypeResult> {
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("The Hermes Switchyard prototype requires Docker on macOS or Linux");
  }
  const dockerEnv = { ...process.env };
  runCapture("docker", ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv });
  runCapture("git", ["--version"]);

  const state: CleanupState = {};
  const supervision: SupervisionState = {};
  const suffix = `${process.pid}-${randomUUID().slice(0, 12)}`;
  state.imageTag = `nemoclaw-hermes-switchyard-prototype:${suffix}`;
  state.containerName = `nemoclaw-hermes-switchyard-prototype-${suffix}`;
  state.tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  chmodSync(state.tempRoot, 0o700);

  let result: PrototypeResult | undefined;
  let primaryError: unknown;
  const onInterrupt = () => {
    supervision.interrupted = "SIGINT";
    if (supervision.activeChild) {
      void terminateChild(supervision.activeChild, supervision.terminationGraceMs);
    }
  };
  const onTerminate = () => {
    supervision.interrupted = "SIGTERM";
    if (supervision.activeChild) {
      void terminateChild(supervision.activeChild, supervision.terminationGraceMs);
    }
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    console.log("[prototype] Preparing the verified pinned Relay source");
    const context = await stageBuildContext(state.tempRoot, supervision);
    console.log("[prototype] Building Relay with in-process Switchyard support");
    await runSupervised(
      "docker",
      ["build", "--progress=plain", "--tag", state.imageTag, context],
      supervision,
      { env: dockerEnv, timeoutMs: 30 * 60 * 1_000 },
    );
    throwIfInterrupted(supervision);
    console.log("[prototype] Running weak/fast and strong/quality Hermes routing turns");
    const runtime = await runSupervised(
      "docker",
      buildRuntimeDockerArgs(state.imageTag, state.containerName),
      supervision,
      {
        capture: true,
        env: dockerEnv,
        timeoutMs: 120_000,
      },
    );
    result = parsePrototypeResult(runtime.stdout, runtime.stderr);
  } catch (error) {
    primaryError = error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }

  const cleanupErrors = cleanup(state, dockerEnv);
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new Error(
        `${primaryError instanceof Error ? primaryError.message : String(primaryError)}\nCleanup also failed:\n${cleanupErrors.join("\n")}`,
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join("\n"));
  }
  if (!result) {
    throw new Error("Prototype completed without a result");
  }

  const completeResult = {
    ...result,
    relay_revision: HERMES_SWITCHYARD_PROTOTYPE.relayRevision,
    relay_pull_ref: HERMES_SWITCHYARD_PROTOTYPE.relayPullRef,
    switchyard_revision: HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision,
    switchyard_source: "relay_cargo_lock",
    rust_builder: HERMES_SWITCHYARD_PROTOTYPE.rustBuilder,
    hermes_image: HERMES_SWITCHYARD_PROTOTYPE.hermesImage,
  };
  console.log(JSON.stringify(completeResult, null, 2));
  return completeResult;
}

function printHelp(): void {
  console.log(`Experimental Hermes -> Relay -> Switchyard prototype

Usage:
  npm run prototype:hermes-switchyard

The command fetches exact unreleased source revisions, builds them in a pinned
Rust image, runs credential-free weak/fast and strong/quality Hermes routing
turns with Docker networking disabled, verifies routing/streaming/cleanup
evidence, and removes its exact temporary image, container, and build directory.

This experimental developer check is not a supported NemoClaw integration.`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  if (process.argv.length > 2) {
    throw new Error("This prototype accepts no options; use --help for usage and limits");
  }
  await runHermesSwitchyardPrototype();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof PrototypeInterruptedError ? error.exitCode : 1;
  });
}
