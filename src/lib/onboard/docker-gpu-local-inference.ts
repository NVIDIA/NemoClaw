// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun } from "../adapters/docker";
import {
  getLocalProviderHealthEndpoint,
  getLocalProviderLabel,
  getLocalProviderValidationBaseUrl,
  LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV,
} from "../inference/local";
import type { SandboxGpuProofResult } from "../state/registry";
import {
  DOCKER_GPU_PATCH_NETWORK_ENV,
  type DockerGpuPatchMode,
  findOpenShellDockerSandboxContainerIds,
  getDockerGpuPatchNetworkMode,
  parseDockerInspectJson,
  printDockerGpuProofFailure,
  shouldApplyDockerGpuPatch,
} from "./docker-gpu-patch";

const {
  LOCAL_INFERENCE_PROVIDERS,
}: { LOCAL_INFERENCE_PROVIDERS: string[] } = require("./providers");

const DOCKER_GPU_INFERENCE_VERIFY_TIMEOUT_MS = 30_000;
const DOCKER_GPU_INFERENCE_PROBE_CONNECT_TIMEOUT_SECS = 5;
const DOCKER_GPU_INFERENCE_PROBE_MAX_TIME_SECS = 10;
const DOCKER_GPU_INFERENCE_PROBE_MAX_ATTEMPTS = 3;
const DOCKER_GPU_INFERENCE_PROBE_RETRY_DELAY_SECS = 2;

type DockerGpuLocalInferenceConfig = {
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice?: string | null;
  // Written back by `verifyGpuSandboxAfterReady` with the CUDA-usability proof
  // result so the registry/`status` can distinguish a configured GPU from a
  // proven-usable one (#4231).
  sandboxGpuProof?: SandboxGpuProofResult | null;
};

type DockerGpuLocalInferenceOptions = {
  dockerDriverGateway: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
};

/**
 * True only on the Linux Docker-driver GPU patch path with
 * `NEMOCLAW_DOCKER_GPU_PATCH_NETWORK=host`, i.e. when the recreated sandbox
 * uses host networking and local inference is wired to the direct loopback URL.
 */
export function shouldUseDockerGpuPatchHostNetwork(
  config: DockerGpuLocalInferenceConfig,
  options: DockerGpuLocalInferenceOptions,
): boolean {
  return (
    shouldApplyDockerGpuPatch(config, {
      dockerDriverGateway: options.dockerDriverGateway,
      env: options.env,
      platform: options.platform,
    }) && getDockerGpuPatchNetworkMode(options.env ?? process.env) === "host"
  );
}

export function configureLocalInferenceForDockerGpuHostNetwork(
  config: DockerGpuLocalInferenceConfig,
  options: DockerGpuLocalInferenceOptions & { note: (message: string) => void },
): void {
  const env = options.env ?? process.env;
  if (!shouldUseDockerGpuPatchHostNetwork(config, options)) return;
  if (!env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV]) {
    env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV] = "http://127.0.0.1";
    options.note(
      "  Docker-driver GPU patch will use host networking; local inference providers will use sandbox loopback.",
    );
    return;
  }
  options.note(
    `  Docker-driver GPU patch will use host networking; local inference providers will use ${LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV}.`,
  );
}

export function dockerGpuPatchHostNetworkInferenceBaseUrl(
  config: DockerGpuLocalInferenceConfig,
  provider: string | null | undefined,
  options: DockerGpuLocalInferenceOptions,
): string | null {
  if (!shouldUseDockerGpuPatchHostNetwork(config, options)) return null;
  if (!provider || !LOCAL_INFERENCE_PROVIDERS.includes(provider)) return null;
  const baseUrl = getLocalProviderValidationBaseUrl(provider);
  if (baseUrl) {
    options.log?.(
      `  Docker-driver GPU host networking: OpenClaw local inference will use direct sandbox URL ${baseUrl}.`,
    );
  }
  return baseUrl;
}

type DockerRunResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type DockerGpuHostNetworkInferenceVerifyDeps = {
  findContainerIds?: (sandboxName: string) => string[];
  dockerCapture?: (args: readonly string[], opts?: Record<string, unknown>) => string;
  dockerRun?: (args: readonly string[], opts?: Record<string, unknown>) => DockerRunResult;
  sleep?: (seconds: number) => void;
};

export type DockerGpuHostNetworkInferenceVerification =
  | { status: "skipped"; reason: string }
  | { status: "ok"; provider: string; containerId: string; networkMode: string; endpoint: string }
  | {
      status: "failed";
      kind: "container-not-found" | "network-mode" | "probe";
      provider: string;
      message: string;
      containerId: string | null;
      networkMode: string | null;
      endpoint: string | null;
      detail: string | null;
      recovery: string[];
    };

/** Flatten a docker run result's stderr/stdout into a single trimmed string. */
function resultText(result: DockerRunResult | null | undefined): string {
  if (!result) return "";
  return `${String(result.stderr || "")} ${String(result.stdout || "")}`.trim();
}

/**
 * Inspect a container and return its `HostConfig.NetworkMode`, or `null` when
 * the inspect output is empty or unparseable.
 */
function inspectContainerNetworkMode(
  containerId: string,
  dockerCaptureFn: NonNullable<DockerGpuHostNetworkInferenceVerifyDeps["dockerCapture"]>,
): string | null {
  try {
    const output = dockerCaptureFn(["inspect", "--type", "container", containerId], {
      ignoreError: true,
      timeout: DOCKER_GPU_INFERENCE_VERIFY_TIMEOUT_MS,
    });
    if (!output || !output.trim()) return null;
    const inspect = parseDockerInspectJson(output);
    const mode = String(inspect.HostConfig?.NetworkMode || "").trim();
    return mode || null;
  } catch {
    return null;
  }
}

/** Returns true when `curl` is on PATH inside the container (probe tooling). */
function containerHasCurl(
  containerId: string,
  dockerRunFn: NonNullable<DockerGpuHostNetworkInferenceVerifyDeps["dockerRun"]>,
): boolean {
  try {
    const result = dockerRunFn(
      ["exec", containerId, "sh", "-lc", "command -v curl >/dev/null 2>&1"],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_INFERENCE_VERIFY_TIMEOUT_MS,
      },
    );
    return Number(result?.status ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * Probe the direct loopback inference endpoint from inside the container with
 * bounded retries. Returns `{ ok: true }` on the first 2xx, otherwise `ok:
 * false` with the last failure detail.
 */
function probeContainerInferenceEndpoint(
  containerId: string,
  endpoint: string,
  deps: {
    dockerRun: NonNullable<DockerGpuHostNetworkInferenceVerifyDeps["dockerRun"]>;
    sleep: NonNullable<DockerGpuHostNetworkInferenceVerifyDeps["sleep"]>;
  },
): { ok: boolean; detail: string | null } {
  let detail: string | null = null;
  for (let attempt = 1; attempt <= DOCKER_GPU_INFERENCE_PROBE_MAX_ATTEMPTS; attempt++) {
    try {
      // Run curl from inside the recreated host-network container so the probe
      // exercises the exact loopback path OpenClaw will use (127.0.0.1 ->
      // host loopback under --network host). Inherit the container's own proxy
      // env so NO_PROXY/loopback handling matches the agent runtime.
      const result = deps.dockerRun(
        [
          "exec",
          containerId,
          "curl",
          "-sf",
          "--connect-timeout",
          String(DOCKER_GPU_INFERENCE_PROBE_CONNECT_TIMEOUT_SECS),
          "--max-time",
          String(DOCKER_GPU_INFERENCE_PROBE_MAX_TIME_SECS),
          "-o",
          "/dev/null",
          endpoint,
        ],
        {
          ignoreError: true,
          suppressOutput: true,
          timeout: DOCKER_GPU_INFERENCE_VERIFY_TIMEOUT_MS,
        },
      );
      if (Number(result?.status ?? 1) === 0) return { ok: true, detail: null };
      detail = resultText(result) || "docker exec curl exited non-zero";
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    if (attempt < DOCKER_GPU_INFERENCE_PROBE_MAX_ATTEMPTS) {
      deps.sleep(DOCKER_GPU_INFERENCE_PROBE_RETRY_DELAY_SECS);
    }
  }
  return { ok: false, detail };
}

/**
 * Post-recreate reachability gate for Docker-driver GPU host-network local
 * inference (#4509). After the GPU patch recreates the sandbox container with
 * `--network host` and OpenClaw is wired to the direct `127.0.0.1` provider
 * URL, prove the real container can actually reach that endpoint before
 * onboarding declares success — otherwise the failure only surfaces later as
 * an opaque `ECONNREFUSED` during an agent prompt.
 *
 * Self-gates: returns `skipped` unless the host-network GPU patch is active
 * for a local inference provider.
 */
export function verifyDockerGpuHostNetworkLocalInference(
  config: DockerGpuLocalInferenceConfig,
  provider: string | null | undefined,
  options: DockerGpuLocalInferenceOptions & {
    sandboxName: string;
    deps?: DockerGpuHostNetworkInferenceVerifyDeps;
  },
): DockerGpuHostNetworkInferenceVerification {
  if (!shouldUseDockerGpuPatchHostNetwork(config, options)) {
    return { status: "skipped", reason: "not-host-network-gpu" };
  }
  if (!provider || !LOCAL_INFERENCE_PROVIDERS.includes(provider)) {
    return { status: "skipped", reason: "not-local-provider" };
  }
  const endpoint = getLocalProviderHealthEndpoint(provider);
  if (!endpoint) {
    return { status: "skipped", reason: "no-health-endpoint" };
  }

  const deps = options.deps ?? {};
  const findContainerIds =
    deps.findContainerIds ?? ((name: string) => findOpenShellDockerSandboxContainerIds(name));
  const dockerCaptureFn = deps.dockerCapture ?? dockerCapture;
  const dockerRunFn = deps.dockerRun ?? dockerRun;
  const sleep =
    deps.sleep ??
    ((seconds: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
    });

  const containerId = findContainerIds(options.sandboxName)[0];
  if (!containerId) {
    return {
      status: "failed",
      kind: "container-not-found",
      provider,
      message: `Could not find the recreated OpenShell Docker container for sandbox '${options.sandboxName}'.`,
      containerId: null,
      networkMode: null,
      endpoint,
      detail: null,
      recovery: [
        "Confirm the sandbox container is running:  openshell sandbox list",
        "Re-run onboarding; the Docker GPU container recreate may not have completed.",
      ],
    };
  }

  const networkMode = inspectContainerNetworkMode(containerId, dockerCaptureFn);
  if (networkMode !== "host") {
    return {
      status: "failed",
      kind: "network-mode",
      provider,
      message:
        `Docker-driver GPU host networking was requested (${DOCKER_GPU_PATCH_NETWORK_ENV}=host) but the ` +
        `recreated sandbox container is on network mode '${networkMode ?? "unknown"}'. OpenClaw is wired ` +
        `to ${endpoint}, which is only reachable under --network host.`,
      containerId,
      networkMode: networkMode ?? null,
      endpoint,
      detail: null,
      recovery: [
        "The GPU patch only switches to --network host when it can rewrite OPENSHELL_ENDPOINT",
        "  from host.openshell.internal to 127.0.0.1; check the recreate logs above.",
        `Re-run with ${DOCKER_GPU_PATCH_NETWORK_ENV}=host, or omit it to use the proxy inference path.`,
      ],
    };
  }

  // Minimal/custom images (e.g. some --from-dockerfile bases) may not ship
  // curl. A missing probe tool must not be reported as an unreachable
  // endpoint — that would turn a tooling gap into a false onboarding failure.
  // Soft-skip with a visible warning instead, preserving prior behavior where
  // there was no gate at all (#4509 review follow-up).
  if (!containerHasCurl(containerId, dockerRunFn)) {
    // Always surface this skip: it is the operator's only explanation for why
    // the reachability proof did not run. Fall back to console.warn when no
    // logger is wired so the warning is never silently dropped.
    const warn = options.log ?? ((message: string) => console.warn(message));
    warn(
      `  ⚠ Skipping host-network local inference reachability check: curl is not available in ${containerId}.`,
    );
    return { status: "skipped", reason: "probe-tool-unavailable" };
  }

  const probe = probeContainerInferenceEndpoint(containerId, endpoint, {
    dockerRun: dockerRunFn,
    sleep,
  });
  if (!probe.ok) {
    return {
      status: "failed",
      kind: "probe",
      provider,
      message: `The recreated host-network sandbox container could not reach the local inference endpoint ${endpoint}.`,
      containerId,
      networkMode,
      endpoint,
      detail: probe.detail,
      recovery: [
        `Confirm the provider is listening on the host loopback:  curl ${endpoint}`,
        "Ensure Ollama/vLLM binds 127.0.0.1 directly (not only a container bridge address).",
        "Check that HTTP_PROXY/NO_PROXY inside the sandbox do not intercept the loopback request.",
        "Set NEMOCLAW_DOCKER_GPU_PATCH=0 to skip the GPU container recreate and use the proxy path.",
      ],
    };
  }

  return { status: "ok", provider, containerId, networkMode, endpoint };
}

/**
 * Print a failed host-network inference verification result as actionable
 * operator output: the message, provider, container, network mode, endpoint,
 * truncated detail, and recovery hints. Defaults to `console.error`.
 */
export function printDockerGpuHostNetworkInferenceVerificationFailure(
  verification: Extract<DockerGpuHostNetworkInferenceVerification, { status: "failed" }>,
  log: (message: string) => void = (message) => console.error(message),
): void {
  const providerLabel = getLocalProviderLabel(verification.provider) ?? verification.provider;
  log("");
  log("  Local inference reachability check failed for the GPU host-network sandbox.");
  log(`  ${verification.message}`);
  log(`  provider=${providerLabel}`);
  if (verification.containerId) log(`  container=${verification.containerId}`);
  if (verification.networkMode) log(`  network_mode=${verification.networkMode}`);
  if (verification.endpoint) log(`  endpoint=${verification.endpoint}`);
  if (verification.detail) log(`  detail=${verification.detail.slice(0, 300)}`);
  log("  Recovery:");
  for (const line of verification.recovery) log(`    ${line}`);
}

export type GpuSandboxAfterReadyOptions = {
  sandboxName: string;
  dockerDriverGateway: boolean;
  useDockerGpuPatch: boolean;
  verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult;
  verifyGpuOrExit?: (
    verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult,
  ) => SandboxGpuProofResult;
  selectedMode: () => DockerGpuPatchMode | null;
  runCaptureOpenshell: (args: string[], opts?: Record<string, unknown>) => string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  deps?: DockerGpuHostNetworkInferenceVerifyDeps;
};

/**
 * Post-readiness GPU sandbox verification orchestrator (kept out of the
 * ~12k-line onboard.ts entrypoint per the codebase-growth guardrail). Runs the
 * direct GPU proof, then — only when the Docker GPU patch recreated the
 * container — gates on host-network local inference reachability (#4509). Exits
 * the process with actionable output if either proof fails.
 */
export function verifyGpuSandboxAfterReady(
  config: DockerGpuLocalInferenceConfig,
  provider: string | null | undefined,
  options: GpuSandboxAfterReadyOptions,
): void {
  try {
    // Capture the CUDA-usability proof result and write it back onto the shared
    // config so onboarding can persist it to the registry and `status` can
    // report proven usability rather than mere configuration (#4231).
    config.sandboxGpuProof = options.verifyGpuOrExit
      ? options.verifyGpuOrExit(options.verifyDirectSandboxGpu)
      : options.verifyDirectSandboxGpu(options.sandboxName);
  } catch (error) {
    // `verifyGpuOrExit` is supplied by the Docker GPU create patch and already
    // prints the richer Error-phase / patched-container diagnostics before
    // rethrowing. Avoid a second generic proof-failure block in that path.
    if (!options.verifyGpuOrExit) {
      printDockerGpuProofFailure(options.sandboxName, error, options.selectedMode(), {
        runCaptureOpenshell: options.runCaptureOpenshell,
      });
    }
    throw error;
  }

  // When NEMOCLAW_DOCKER_GPU_PATCH=0, useDockerGpuPatch is false and there is no
  // recreated container to probe, so skip the host-network inference gate.
  if (!options.useDockerGpuPatch) return;
  const verification = verifyDockerGpuHostNetworkLocalInference(config, provider, {
    sandboxName: options.sandboxName,
    dockerDriverGateway: options.dockerDriverGateway,
    env: options.env,
    platform: options.platform,
    log: options.log,
    deps: options.deps,
  });
  const log = options.log ?? console.log;
  if (verification.status === "ok") {
    log(`  ✓ GPU host-network local inference reachable from sandbox: ${verification.endpoint}`);
  } else if (verification.status === "failed") {
    // Route failure diagnostics through the caller-provided error sink so
    // wrappers / structured log collectors still see them; defaults to
    // console.error (onboard's stderr error channel).
    printDockerGpuHostNetworkInferenceVerificationFailure(
      verification,
      options.logError ?? ((message) => console.error(message)),
    );
    process.exit(1);
  }
}
