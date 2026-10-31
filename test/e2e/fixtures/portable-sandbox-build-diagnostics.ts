// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "./artifacts.ts";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { superviseChild } from "../../helpers/process-supervisor.ts";
import { spawnObservedChild } from "./observed-child-process.ts";
import type { TestProgress } from "./progress.ts";

export const PORTABLE_IMAGE_COMMAND_TIMEOUT_MS = 6 * 60_000;
export const PORTABLE_GATEWAY_STARTUP_BUDGET_MS = 15_000;
export const PORTABLE_SANDBOX_CREATE_BUDGET_MS = 240_000;
export const PORTABLE_HERMES_LIFECYCLE_BUDGET_MS = 2 * 240_000 + 2 * (60_000 + 30_000);
export const PORTABLE_SANDBOX_DELETE_BUDGET_MS = 60_000;
export const PORTABLE_ASSERTION_CLEANUP_RESERVE_MS = 6 * 60_000;
// Two prebuilds each build and publish; preserve the existing gateway, create,
// two public starts and stops, deletion, and assertion/cleanup allowances.
export const PORTABLE_PROFILE_LIVE_TIMEOUT_MS =
  4 * PORTABLE_IMAGE_COMMAND_TIMEOUT_MS +
  PORTABLE_GATEWAY_STARTUP_BUDGET_MS +
  PORTABLE_SANDBOX_CREATE_BUDGET_MS +
  PORTABLE_HERMES_LIFECYCLE_BUDGET_MS +
  PORTABLE_SANDBOX_DELETE_BUDGET_MS +
  PORTABLE_ASSERTION_CLEANUP_RESERVE_MS;
const DIAGNOSTIC_TAIL_CHARS = 8_192;
const POST_KILL_OUTPUT_DRAIN_MS = 1_000;
const OCI_PROBE_TIMEOUT_MS = 30_000;
const OCI_PROBE_CLEANUP_TIMEOUT_MS = 15_000;
const SAFE_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM", "ETIMEDOUT", "EUNRECONCILED"]);
const ROOTLESS_RUNTIME_DIR = /^\/run\/user\/[0-9]{1,10}$/u;
const PODMAN_NETWORK_ID = /^[a-f0-9]{64}$/u;
const PODMAN_NETWORK_NAME = /^nemoclaw-portable-id-proof-[0-9]{1,10}$/u;
const PORTABLE_HERMES_IMAGE_REF =
  /^127\.0\.0\.1:5000\/nemoclaw-sandbox-local:[a-z0-9][a-z0-9_.-]{0,126}$/u;
type BuildResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: string;
  error?: Error;
  unreconciledGroupId?: number;
  stdoutObserved?: boolean;
  stderrObserved?: boolean;
};

type ImageCommandRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
) => Promise<BuildResult>;

type StoreIdentity = { graphRoot: string; runRoot: string; ociRuntimePath: string };
type StoreProbe = (env: NodeJS.ProcessEnv, selectedUrl?: string) => StoreIdentity;

function alignPrivatePodmanStorage(configHome: string, env: NodeJS.ProcessEnv): boolean {
  const source = env.CONTAINERS_STORAGE_CONF;
  if (!source) return false;
  const destination = path.join(configHome, "containers", "storage.conf");
  const noFollow = fs.constants.O_NOFOLLOW;
  try {
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    let contents: Buffer;
    try {
      const sourceStat = fs.fstatSync(sourceFd);
      if (!sourceStat.isFile() || sourceStat.size > 65_536) throw new Error("invalid source");
      contents = fs.readFileSync(sourceFd);
    } finally {
      fs.closeSync(sourceFd);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    let destinationFd: number;
    try {
      destinationFd = fs.openSync(
        destination,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      try {
        fs.writeFileSync(destinationFd, contents);
      } finally {
        fs.closeSync(destinationFd);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      destinationFd = fs.openSync(destination, fs.constants.O_RDONLY | noFollow);
      try {
        const destinationStat = fs.fstatSync(destinationFd);
        if (
          !destinationStat.isFile() ||
          (destinationStat.mode & 0o777) !== 0o600 ||
          !fs.readFileSync(destinationFd).equals(contents)
        ) {
          throw new Error("existing config differs");
        }
      } finally {
        fs.closeSync(destinationFd);
      }
    }
    return true;
  } catch {
    throw new Error("Portable Podman storage config alignment failed");
  }
}

export function probePodmanStore(
  env: NodeJS.ProcessEnv,
  selectedUrl?: string,
  runInfo: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => {
    status: number | null;
    stdout: string;
    error?: Error;
  } = (args, selectedEnv) =>
    spawnSync("podman", args, {
      env: selectedEnv,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 65_536,
    }),
): StoreIdentity {
  const result = runInfo(
    selectedUrl ? ["--url", selectedUrl, "info", "--format", "json"] : ["info", "--format", "json"],
    env,
  );
  if (result.error || result.status !== 0) throw new Error("probe");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("parse");
  }
  const info = parsed as {
    store?: Partial<StoreIdentity>;
    host?: { ociRuntime?: { path?: unknown } };
    Host?: { OCIRuntime?: { Path?: unknown } };
  };
  const store = info?.store;
  const ociRuntimePath = info?.host?.ociRuntime?.path ?? info?.Host?.OCIRuntime?.Path;
  if (
    typeof store?.graphRoot !== "string" ||
    !store.graphRoot ||
    typeof store.runRoot !== "string" ||
    !store.runRoot ||
    typeof ociRuntimePath !== "string" ||
    !ociRuntimePath
  ) {
    throw new Error("missing-field");
  }
  return { graphRoot: store.graphRoot, runRoot: store.runRoot, ociRuntimePath };
}

/** Compare fixed store and runtime authority; never publish Podman paths or command output. */
export async function verifyPortablePodmanStoreAuthority(
  childEnv: NodeJS.ProcessEnv,
  fullEnv: NodeJS.ProcessEnv,
  selectedUrl: string,
  configHome: string,
  artifactName: string,
  artifacts: ArtifactSink,
  probe: StoreProbe = probePodmanStore,
): Promise<void> {
  if (fullEnv.CONTAINERS_STORAGE_CONF && (!configHome || childEnv.XDG_CONFIG_HOME !== configHome)) {
    throw new Error("Portable Podman storage config alignment failed");
  }
  if (!alignPrivatePodmanStorage(configHome, fullEnv)) return;
  let category = "match";
  let childMatchesHost: boolean | null = null;
  let hostMatchesService: boolean | null = null;
  let childMatchesHostRuntime: boolean | null = null;
  let hostMatchesServiceRuntime: boolean | null = null;
  try {
    if (!selectedUrl.startsWith("unix:///")) throw new Error("probe");
    const child = probe(childEnv);
    const host = probe(fullEnv);
    const service = probe(fullEnv, selectedUrl);
    childMatchesHost = child.graphRoot === host.graphRoot && child.runRoot === host.runRoot;
    hostMatchesService = host.graphRoot === service.graphRoot && host.runRoot === service.runRoot;
    childMatchesHostRuntime = child.ociRuntimePath === host.ociRuntimePath;
    hostMatchesServiceRuntime = host.ociRuntimePath === service.ociRuntimePath;
    if (
      !childMatchesHost ||
      !hostMatchesService ||
      !childMatchesHostRuntime ||
      !hostMatchesServiceRuntime
    )
      throw new Error("mismatch");
  } catch (cause) {
    category = ["probe", "parse", "missing-field", "mismatch"].includes((cause as Error).message)
      ? (cause as Error).message
      : "probe";
  }
  await artifacts.writeJson(artifactName, {
    schemaVersion: 1,
    category,
    childMatchesHost,
    hostMatchesService,
    childMatchesHostRuntime,
    hostMatchesServiceRuntime,
  });
  if (category !== "match") throw new Error(`Portable Podman store authority ${category}`);
}

/** Carry the trusted crun and Netavark backend across portable host config regeneration. */
export function preservePortableE2eCrun(
  configPath: string,
  expectedRuntimePath: string,
  selectedUrl: string,
  env: NodeJS.ProcessEnv,
  probe: StoreProbe = probePodmanStore,
): void {
  if (
    !/^\/usr\/local\/libexec\/nemoclaw\/portable-crun\.[1-9][0-9]*\.[1-9][0-9]*$/u.test(
      expectedRuntimePath,
    ) ||
    !selectedUrl.startsWith("unix:///") ||
    probe(env, selectedUrl).ociRuntimePath !== expectedRuntimePath
  ) {
    throw new Error("Portable E2E crun authority mismatch");
  }
  let fd: number;
  try {
    fd = fs.openSync(configPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error("Portable E2E runtime config authority mismatch");
  }
  try {
    const stat = fs.fstatSync(fd);
    const contents = fs.readFileSync(fd, "utf8");
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      contents.includes("[engine.runtimes]") ||
      contents.split('firewall_driver = "iptables"').length !== 2
    ) {
      throw new Error("Portable E2E runtime config authority mismatch");
    }
    // The pinned CI Netavark 2.1 rejects the product's iptables backend. Keep
    // the product-generated config intact until this test-only runtime handoff.
    // The trusted native Podman service already selects nftables.
    const adapted = contents.replace(
      'firewall_driver = "iptables"',
      'firewall_driver = "nftables"',
    );
    const selected = `${adapted}\n[engine.runtimes]\ncrun = ["${expectedRuntimePath}"]\n`;
    fs.writeSync(fd, selected, 0, "utf8");
    fs.ftruncateSync(fd, Buffer.byteLength(selected));
  } finally {
    fs.closeSync(fd);
  }
  if (probe(env).ociRuntimePath !== expectedRuntimePath) {
    throw new Error("Portable E2E local crun selection mismatch");
  }
}

/** Apply the trusted runtime handoff only to the Portable Hermes job that pins crun. */
export function preservePortableE2eCrunForTarget(
  env: NodeJS.ProcessEnv,
  selectedUrl: string,
): void {
  if (env.E2E_TARGET_ID !== "portable-hermes-finalization") return;
  preservePortableE2eCrun(
    String(env.CONTAINERS_CONF),
    `/usr/local/libexec/nemoclaw/portable-crun.${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}`,
    selectedUrl,
    env,
  );
}

/** Run every owned cleanup step and retain the lifecycle failure when cleanup also fails. */
export async function runPortableE2eWithCleanup(
  work: () => Promise<void>,
  cleanup: readonly (() => Promise<void> | void)[],
): Promise<void> {
  let primaryFailure: unknown;
  let workFailed = false;
  try {
    await work();
  } catch (error) {
    primaryFailure = error;
    workFailed = true;
  }
  const cleanupFailures: unknown[] = [];
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (workFailed && cleanupFailures.length) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Portable E2E lifecycle and cleanup failed",
      { cause: primaryFailure },
    );
  }
  if (workFailed) throw primaryFailure;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, "Portable E2E cleanup failed");
  }
}

export function retirePortableGeneratedBuildContext(context: string | null): boolean {
  if (!context) return true;
  fs.rmSync(context, { force: true, recursive: true });
  return !fs.existsSync(context);
}

async function runPodmanBuild(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
): Promise<BuildResult> {
  let child: ReturnType<typeof spawnObservedChild>;
  try {
    child = spawnObservedChild("podman", args, {
      activityLabel:
        args[0] === "push"
          ? "command: portable-sandbox-image-publish"
          : args[0] === "build"
            ? "command: portable-sandbox-image-build"
            : "command: portable-sandbox-oci-diagnostic",
      progress,
      spawn: { env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true },
    });
  } catch (cause) {
    return {
      status: null,
      signal: null,
      diagnostic: "",
      error: cause instanceof Error ? cause : new Error("Podman image command could not start"),
    };
  }
  let diagnostic = "";
  let stdoutObserved = false;
  let stderrObserved = false;
  const appendDiagnostic = (chunk: string) => {
    // Dockerfile steps can print credentials. Keep only a bounded in-memory tail.
    diagnostic = (diagnostic + chunk).slice(-DIAGNOSTIC_TAIL_CHARS);
  };
  const result = await superviseChild(child, {
    timeoutMs,
    killGraceMs: 0,
    postKillOutputDrainMs: POST_KILL_OUTPUT_DRAIN_MS,
    onStdout: (chunk) => {
      stdoutObserved ||= chunk.length > 0;
      appendDiagnostic(chunk);
    },
    onStderr: (chunk) => {
      stderrObserved ||= chunk.length > 0;
      appendDiagnostic(chunk);
    },
  });
  const error = result.cleanupError
    ? Object.assign(new Error("Podman build group was not reconciled"), { code: "EUNRECONCILED" })
    : result.timedOut
      ? Object.assign(new Error("Podman image command timed out"), { code: "ETIMEDOUT" })
      : result.spawnError;
  return {
    status: result.exitCode,
    signal: result.signal,
    diagnostic,
    error,
    unreconciledGroupId: result.cleanupError ? child.pid : undefined,
    stdoutObserved,
    stderrObserved,
  };
}

function failureCategory(output: string): string {
  const diagnostic = output.slice(-8_192).toLowerCase();
  if (/no space left on device|enospc/u.test(diagnostic)) return "disk-full";
  if (/permission denied|operation not permitted|eacces|eperm/u.test(diagnostic))
    return "permission";
  if (
    /connection refused|connection reset|network is unreachable|timed out|timeout/u.test(diagnostic)
  )
    return "network";
  if (/unauthorized|authentication required|denied: requested access/u.test(diagnostic))
    return "registry-auth";
  if (/manifest unknown|pull access denied|failed to resolve source metadata/u.test(diagnostic))
    return "base-image-unavailable";
  if (
    /no such file or directory|not found in build context|failed to calculate checksum/u.test(
      diagnostic,
    )
  )
    return "build-context";
  if (/cgroup|pids[.]max|clone3/u.test(diagnostic)) return "process-isolation";
  if (/overlay|storage|mount/u.test(diagnostic)) return "storage";
  return "unclassified";
}

function observedBuildStep(output: string): "base-image" | "dockerfile-run" | "unknown" {
  const stepLines = [...output.matchAll(/^STEP [1-9]\d*\/[1-9]\d*: (FROM|RUN)\b/gmu)];
  const lastStep = stepLines.at(-1)?.[1];
  if (lastStep === "FROM") return "base-image";
  if (lastStep === "RUN") return "dockerfile-run";
  return "unknown";
}

function fixedFailureEvidence(result: BuildResult) {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    schemaVersion: 1,
    status: result.status,
    signal: result.signal,
    errorCode: errorCode && SAFE_ERROR_CODES.has(errorCode) ? errorCode : null,
    category:
      errorCode === "EUNRECONCILED" ? "process-isolation" : failureCategory(result.diagnostic),
    observedBuildStep: observedBuildStep(result.diagnostic),
  };
}

function fixedBuildDiagnosticShape(result: BuildResult) {
  const tail = result.diagnostic.slice(-DIAGNOSTIC_TAIL_CHARS);
  const terminalErrors = tail
    .split(/\r?\n/u)
    .filter((line) => /^\s*(?:error|fatal):|\blevel=error\b/iu.test(line))
    .slice(-4)
    .join("\n")
    .toLowerCase();
  const patterns = [
    ["runtime", /\b(?:oci runtime|crun|runc|runtime)\b/u],
    ["container", /\b(?:build container|container create|creating container)\b/u],
    ["commit", /\b(?:commit|committing|writing manifest)\b/u],
    ["storage", /\b(?:overlay|storage|mount|graphroot)\b/u],
    ["bus", /\b(?:dbus|d-bus|bus address|systemd)\b/u],
    ["namespace", /\b(?:userns|user namespace|subuid|subgid)\b/u],
    ["network", /\b(?:network|connection|dial tcp)\b/u],
    ["registry", /\b(?:registry|manifest|pull)\b/u],
    ["exec", /\b(?:exec|executable|process)\b/u],
  ] as const;
  return {
    schemaVersion: 1,
    stdoutObserved: result.stdoutObserved ?? null,
    stderrObserved: result.stderrObserved ?? null,
    terminalErrorObserved: terminalErrors.length > 0,
    commitObserved: /^COMMIT\b/mu.test(tail),
    signals: patterns.filter(([, pattern]) => pattern.test(terminalErrors)).map(([name]) => name),
  };
}

/** Keep only fixed failure categories from the fixed live build. */
export async function buildPortableSandboxImageWithEvidence(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  artifacts: ArtifactSink,
  progress: TestProgress,
  runBuild: ImageCommandRunner = runPodmanBuild,
  onReconciled?: (reconciled: boolean, groupId?: number) => void,
): Promise<number | null> {
  let result: BuildResult;
  try {
    result = await runBuild(args, options.env, PORTABLE_IMAGE_COMMAND_TIMEOUT_MS, progress);
  } catch (error) {
    onReconciled?.(false);
    throw error;
  }
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "EUNRECONCILED")
    onReconciled?.(false, result.unreconciledGroupId);
  else onReconciled?.(true);
  if (result.status !== 0 || result.error) {
    await artifacts.writeJson(
      "portable-sandbox-image-build-failure.json",
      fixedFailureEvidence(result),
    );
    if (failureCategory(result.diagnostic) === "unclassified") {
      await artifacts.writeJson(
        "portable-sandbox-image-build-diagnostic-shape.json",
        fixedBuildDiagnosticShape(result),
      );
    }
  }
  return result.error ? null : result.status;
}

async function diagnosticCommand(
  runCommand: ImageCommandRunner,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
): Promise<BuildResult> {
  try {
    return await runCommand(args, env, timeoutMs, progress);
  } catch {
    return {
      status: null,
      signal: null,
      diagnostic: "",
      error: Object.assign(new Error("diagnostic reconciliation unknown"), {
        code: "EUNRECONCILED",
      }),
    };
  }
}

/** Distinguish local OCI execution from build failure without publishing child output. */
export async function probePortableSandboxOciAfterBuildFailure(
  baseImage: string,
  env: NodeJS.ProcessEnv,
  artifacts: ArtifactSink,
  progress: TestProgress,
  runCommand: ImageCommandRunner = runPodmanBuild,
  onUnreconciled?: (groupId?: number) => void,
): Promise<void> {
  const cached = await diagnosticCommand(
    runCommand,
    ["image", "exists", baseImage],
    env,
    OCI_PROBE_CLEANUP_TIMEOUT_MS,
    progress,
  );
  if (cached.status !== 0 || cached.error) {
    const unreconciled =
      (cached.error as NodeJS.ErrnoException | undefined)?.code === "EUNRECONCILED";
    if (unreconciled) onUnreconciled?.(cached.unreconciledGroupId);
    await artifacts.writeJson("portable-sandbox-oci-probe.json", {
      schemaVersion: 1,
      category: unreconciled
        ? "cleanup-unproved"
        : cached.status === 1 && !cached.error
          ? "base-image-absent"
          : "image-query-failed",
      baseImageCached: cached.status === 1 && !cached.error ? false : null,
      runStatus: null,
      cleanupSucceeded: unreconciled ? false : null,
    });
    if (unreconciled) {
      throw new Error("Portable sandbox OCI probe cleanup unproved");
    }
    return;
  }
  const name = `nemoclaw-prebuild-probe-${randomUUID()}`;
  const run = await diagnosticCommand(
    runCommand,
    ["run", "--rm", "--pull=never", "--network=none", "--name", name, baseImage, "/bin/true"],
    env,
    OCI_PROBE_TIMEOUT_MS,
    progress,
  );
  const unreconciled = (run.error as NodeJS.ErrnoException | undefined)?.code === "EUNRECONCILED";
  if (unreconciled) onUnreconciled?.(run.unreconciledGroupId);
  const cleanup = unreconciled
    ? null
    : await diagnosticCommand(
        runCommand,
        ["rm", "--force", "--ignore", name],
        env,
        OCI_PROBE_CLEANUP_TIMEOUT_MS,
        progress,
      );
  if ((cleanup?.error as NodeJS.ErrnoException | undefined)?.code === "EUNRECONCILED")
    onUnreconciled?.(cleanup?.unreconciledGroupId);
  const cleanupSucceeded = cleanup?.status === 0 && !cleanup.error && !unreconciled;
  const category = !cleanupSucceeded
    ? "cleanup-unproved"
    : run.status === 0 && !run.error
      ? "oci-execution-passed"
      : (run.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
        ? "oci-execution-timeout"
        : "oci-execution-failed";
  await artifacts.writeJson("portable-sandbox-oci-probe.json", {
    schemaVersion: 1,
    category,
    baseImageCached: true,
    runStatus: run.status,
    cleanupSucceeded,
  });
  if (category === "cleanup-unproved")
    throw new Error("Portable sandbox OCI probe cleanup unproved");
}

/** Use the exact filtered child environment passed by the production prebuild callback. */
type PortableSandboxImageBuilderHelpers = {
  verifyAuthority: typeof verifyPortablePodmanStoreAuthority;
  buildWithEvidence: typeof buildPortableSandboxImageWithEvidence;
  probeOci: typeof probePortableSandboxOciAfterBuildFailure;
};

export function portableSandboxImageBuilder(
  artifacts: ArtifactSink,
  progress: TestProgress,
  selectedUrl: string,
  sandboxBaseImage: string,
  helpers: PortableSandboxImageBuilderHelpers = {
    verifyAuthority: verifyPortablePodmanStoreAuthority,
    buildWithEvidence: buildPortableSandboxImageWithEvidence,
    probeOci: probePortableSandboxOciAfterBuildFailure,
  },
  onUnreconciled?: (groupId?: number) => void,
) {
  return (label: "sandbox" | "hermes") =>
    async (args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: "inherit" }) => {
      await helpers.verifyAuthority(
        options.env,
        process.env,
        selectedUrl,
        options.env.XDG_CONFIG_HOME ?? "",
        `portable-podman-store-${label}.json`,
        artifacts,
      );
      let reconciled = false;
      const status = await helpers.buildWithEvidence(
        args,
        options,
        artifacts,
        progress,
        undefined,
        (value, groupId) => {
          reconciled = value;
          if (!value) onUnreconciled?.(groupId);
        },
      );
      // A surviving build process group forbids another Podman command.
      if (label === "sandbox" && status !== 0 && reconciled) {
        await helpers.probeOci(
          sandboxBaseImage,
          options.env,
          artifacts,
          progress,
          undefined,
          onUnreconciled,
        );
      }
      return status;
    };
}

async function waitForPodmanGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(-groupId, 0);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") return true;
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export function createPodmanGroupReconciliationTracker() {
  let seen = false;
  let groupId: number | undefined;
  let identityUnproved = false;
  return {
    mark(observedGroupId?: number) {
      seen = true;
      if (
        observedGroupId === undefined ||
        !Number.isSafeInteger(observedGroupId) ||
        observedGroupId <= 0 ||
        (groupId !== undefined && groupId !== observedGroupId)
      ) {
        identityUnproved = true;
      } else {
        groupId = observedGroupId;
      }
    },
    recoveryState() {
      return {
        unreconciled: seen,
        unreconciledGroupId: identityUnproved ? undefined : groupId,
      };
    },
  };
}

/** Reconcile the supervised group before removing test-owned Podman resources. */
type CleanupCommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export async function cleanupPortablePodmanResources(
  input: {
    artifacts: ArtifactSink;
    unreconciled: boolean;
    unreconciledGroupId?: number;
    selectedPodmanUrl: string | null;
    disposableNetworkCreated: boolean;
    disposableNetworkId: string | null;
    disposableNetworkName: string;
    runtimeDir: string;
    hermesImageRef: string | null;
    env: NodeJS.ProcessEnv;
  },
  runCommand: (args: string[]) => CleanupCommandResult = (args) =>
    spawnSync("podman", args, {
      env: input.env,
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: 15_000,
    }),
  waitForGroupExit: (
    groupId: number,
    timeoutMs: number,
  ) => Promise<boolean> = waitForPodmanGroupExit,
): Promise<void> {
  if (input.unreconciled) {
    const network = input.disposableNetworkCreated
      ? input.disposableNetworkId && PODMAN_NETWORK_ID.test(input.disposableNetworkId)
        ? input.disposableNetworkId
        : PODMAN_NETWORK_NAME.test(input.disposableNetworkName)
          ? input.disposableNetworkName
          : null
      : null;
    await input.artifacts.writeJson("portable-podman-cleanup-state.json", {
      schemaVersion: 1,
      status: "skipped-unreconciled-process",
      resumeAfter: "supervised-process-group-exited",
      selectedPodmanSocket:
        ROOTLESS_RUNTIME_DIR.test(input.runtimeDir) &&
        input.selectedPodmanUrl === `unix://${input.runtimeDir}/podman/podman.sock`
          ? `${input.runtimeDir}/podman/podman.sock`
          : null,
      skippedTargets: {
        network,
        registryContainer: "nemoclaw-portable-registry",
        hermesImage:
          input.hermesImageRef && PORTABLE_HERMES_IMAGE_REF.test(input.hermesImageRef)
            ? input.hermesImageRef
            : null,
        podmanSystemReset: true,
      },
    });
    const groupId = input.unreconciledGroupId;
    if (groupId === undefined || !Number.isSafeInteger(groupId) || groupId <= 0)
      throw new Error("Portable Podman cleanup recovery identity unproved");
    if (!(await waitForGroupExit(groupId, 5_000)))
      throw new Error("Portable Podman cleanup process group exit unproved");
  }
  const selectedUrl = input.selectedPodmanUrl;
  if (!selectedUrl?.startsWith("unix:///")) {
    await input.artifacts.writeJson("portable-podman-cleanup-failure.json", {
      schemaVersion: 1,
      failedTargets: [{ target: "authority", category: "unproved" }],
    });
    throw new Error("Portable Podman cleanup authority unproved");
  }
  const failedTargets: Array<{ target: string; category: string }> = [];
  const attempt = (target: string, args: string[], local = false) => {
    try {
      const result = runCommand(
        local ? ["--remote=false", ...args] : ["--url", selectedUrl, ...args],
      );
      const category =
        (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
          ? "timeout"
          : result.error
            ? "spawn-error"
            : result.signal
              ? "signal"
              : result.status === 0
                ? null
                : result.status === null
                  ? "unknown-result"
                  : "nonzero-exit";
      if (category) failedTargets.push({ target, category });
    } catch {
      failedTargets.push({ target, category: "invocation-error" });
    }
  };
  if (input.disposableNetworkCreated)
    attempt("network", ["network", "rm", input.disposableNetworkId ?? input.disposableNetworkName]);
  attempt("registry", ["rm", "--force", "nemoclaw-portable-registry"]);
  if (input.hermesImageRef)
    attempt("hermes-image", ["image", "rm", "--force", input.hermesImageRef]);
  // Podman system reset is local-only. Limit it to the selected default socket;
  // named resources above are removed through the selected service in every case.
  if (
    ROOTLESS_RUNTIME_DIR.test(input.runtimeDir) &&
    selectedUrl === `unix://${input.runtimeDir}/podman/podman.sock`
  ) {
    attempt("system-reset", ["system", "reset", "--force"], true);
  } else {
    await input.artifacts.writeJson("portable-podman-cleanup-state.json", {
      schemaVersion: 1,
      status: "local-system-reset-skipped",
      reason: "selected-socket-is-not-local-default",
    });
  }
  if (failedTargets.length > 0) {
    await input.artifacts.writeJson("portable-podman-cleanup-failure.json", {
      schemaVersion: 1,
      failedTargets,
    });
    throw new Error("Portable Podman cleanup failed for test-owned resources");
  }
  if (input.unreconciled)
    await input.artifacts.writeJson("portable-podman-cleanup-reconciliation.json", {
      schemaVersion: 1,
      status: "reconciled-cleanup-completed",
    });
}

/** Keep registry publication separate from build-failure evidence. */
export async function publishPortableSandboxImage(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  artifacts: ArtifactSink,
  progress: TestProgress,
  runPublish: ImageCommandRunner = runPodmanBuild,
  onUnreconciled?: (groupId?: number) => void,
): Promise<number | null> {
  let result: BuildResult;
  try {
    result = await runPublish(args, options.env, PORTABLE_IMAGE_COMMAND_TIMEOUT_MS, progress);
  } catch (error) {
    onUnreconciled?.();
    throw error;
  }
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "EUNRECONCILED")
    onUnreconciled?.(result.unreconciledGroupId);
  if (result.status !== 0 || result.error) {
    await artifacts.writeJson(
      "portable-sandbox-image-publish-failure.json",
      fixedFailureEvidence(result),
    );
  }
  return result.error ? null : result.status;
}
