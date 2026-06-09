// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getLocalProviderLabel } from "../inference/local";
import type { SandboxGpuProofResult } from "../state/registry";
import {
  DOCKER_GPU_PATCH_NETWORK_ENV,
  type DockerGpuPatchMode,
  getDockerGpuPatchNetworkMode,
  printDockerGpuProofFailure,
  shouldApplyDockerGpuPatch,
} from "./docker-gpu-patch";
import { executeSandboxCommandForVerification } from "./sandbox-verification-exec";

const {
  LOCAL_INFERENCE_PROVIDERS,
}: { LOCAL_INFERENCE_PROVIDERS: string[] } = require("./providers");

const DOCKER_GPU_INFERENCE_PROBE_CONNECT_TIMEOUT_SECS = 5;
const DOCKER_GPU_INFERENCE_PROBE_MAX_TIME_SECS = 10;
const DOCKER_GPU_INFERENCE_PROBE_MAX_ATTEMPTS = 3;
const DOCKER_GPU_INFERENCE_PROBE_RETRY_DELAY_SECS = 2;

// The OpenShell inference route OpenClaw's LLM client actually uses inside the
// sandbox. It is served by the OpenShell L7 proxy/router and routes to the
// configured provider backend — the same hostname the agent talks to (see
// verify-deployment.ts:verifyInferenceRoute). Probing it from the sandbox
// runtime exercises the exact path the agent uses, not a host-only shortcut.
const SANDBOX_RUNTIME_INFERENCE_ENDPOINT = "https://inference.local/v1/models";

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

function isLocalInferenceProvider(provider: string | null | undefined): provider is string {
  return Boolean(provider && LOCAL_INFERENCE_PROVIDERS.includes(provider));
}

/**
 * True on the Linux Docker-driver GPU patch path with
 * `NEMOCLAW_DOCKER_GPU_PATCH_NETWORK=host`, i.e. when the recreated sandbox was
 * requested with host networking.
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

/**
 * The OpenShell Docker-driver sandbox runs the agent in its own (isolated)
 * network namespace — see `detectSandboxFallbackDns` in docker-gpu-patch.ts —
 * so `127.0.0.1` inside the agent runtime is the sandbox's own loopback, not
 * the host's, even when the recreated outer container is `--network host`. The
 * opt-in host-network GPU mode (`NEMOCLAW_DOCKER_GPU_PATCH_NETWORK=host`) was
 * only ever meant to let OpenClaw reach a host-loopback inference server
 * directly, but that loopback is unreachable from the sandbox namespace: the
 * agent fails at runtime with `ECONNREFUSED` ("LLM request failed: network
 * connection error") while a `docker exec` probe — running in the container's
 * main namespace, which IS the host under `--network host` — falsely succeeds.
 * That mismatch is the reopened-#4509 false positive.
 *
 * Host networking is also unnecessary for GPU device access (that comes from
 * the GPU mode flags — `--gpus`/CDI/NVIDIA runtime — independent of the
 * container network mode). So downgrade the recreate to the OpenShell-managed
 * bridge network (`preserve`), where local inference routes through the
 * reachable `inference.local` path the sandbox namespace can use.
 *
 * Scoped to LOCAL inference providers — that is the only case the host-network
 * opt-in was meant to serve, and the only one this breaks. Non-local (cloud /
 * routed / custom) GPU sandboxes keep their requested network mode untouched.
 * Runs at sandbox build time, after the provider is resolved and before the GPU
 * container recreate reads the network mode.
 *
 * When a downgrade is applied, also re-runs the sandbox bridge reachability
 * probe (with UFW auto-fix): gateway startup skipped it on the assumption that
 * the sandbox would be on host networking, but the sandbox is now committed to
 * the OpenShell bridge, so a default-deny firewall must fail fast / self-heal
 * before the build rather than surface as a late, opaque failure.
 *
 * Returns true when a downgrade was applied.
 */
export async function enforceDockerGpuPatchPreserveNetwork(
  provider: string | null | undefined,
  config: DockerGpuLocalInferenceConfig,
  options: DockerGpuLocalInferenceOptions & {
    reverifyBridgeReachability?: () => void | Promise<void>;
  },
): Promise<boolean> {
  if (!isLocalInferenceProvider(provider)) return false;
  if (!shouldUseDockerGpuPatchHostNetwork(config, options)) return false;
  const env = options.env ?? process.env;
  env[DOCKER_GPU_PATCH_NETWORK_ENV] = "preserve";
  options.log?.(
    "  Docker-driver GPU patch keeps OpenShell bridge networking for local inference: the host " +
      "loopback is not reachable from the sandbox network namespace, so OpenClaw routes through " +
      "the OpenShell-managed inference path (host networking is not needed for GPU device access).",
  );
  await (options.reverifyBridgeReachability ?? defaultReverifyBridgeReachability)();
  return true;
}

/** Re-run the sandbox→gateway bridge reachability probe (with UFW auto-fix). */
function defaultReverifyBridgeReachability(): Promise<void> {
  const { verifySandboxBridgeGatewayReachableOrExit } =
    require("./gateway-sandbox-reachability") as typeof import("./gateway-sandbox-reachability");
  return verifySandboxBridgeGatewayReachableOrExit(true, { skip: false });
}

export type SandboxExecResult = { status: number; stdout: string; stderr: string } | null;

export type DockerGpuSandboxInferenceVerifyDeps = {
  execInSandbox?: (sandboxName: string, script: string) => SandboxExecResult;
  sleep?: (seconds: number) => void;
};

export type DockerGpuSandboxInferenceVerification =
  | { status: "skipped"; reason: string }
  | { status: "ok"; provider: string; endpoint: string; httpCode: string }
  | {
      status: "failed";
      kind: "exec" | "unreachable";
      provider: string;
      endpoint: string;
      message: string;
      detail: string | null;
      recovery: string[];
    };

/** The runtime inference route to probe for a provider (local providers only). */
export function getSandboxRuntimeInferenceEndpoint(
  provider: string | null | undefined,
): string | null {
  return isLocalInferenceProvider(provider) ? SANDBOX_RUNTIME_INFERENCE_ENDPOINT : null;
}

type RuntimeProbeOutcome =
  | { kind: "ok"; httpCode: string }
  | { kind: "no-curl" }
  | { kind: "exec-failed"; detail: string }
  | { kind: "unreachable"; detail: string };

/**
 * Probe the inference route from the actual OpenClaw runtime context via
 * `openshell sandbox exec` — the sandbox's own network namespace, the context
 * the agent's LLM client runs in — rather than `docker exec` against the
 * recreated container, whose main namespace is the host's under `--network
 * host` and therefore masked the #4509 failure.
 *
 * A single script proves the exec path works (it emits a sentinel), reports a
 * genuinely missing `curl` separately from an exec failure, and otherwise hits
 * `inference.local` exactly as OpenClaw does (through the sandbox proxy). This
 * mirrors verify-deployment.ts:verifyInferenceRoute: any HTTP status means the
 * route resolves and responds; `000` means DNS failure or connection refused —
 * the reopened-#4509 symptom.
 */
function probeSandboxRuntimeInference(
  sandboxName: string,
  endpoint: string,
  deps: {
    execInSandbox: NonNullable<DockerGpuSandboxInferenceVerifyDeps["execInSandbox"]>;
    sleep: NonNullable<DockerGpuSandboxInferenceVerifyDeps["sleep"]>;
  },
): RuntimeProbeOutcome {
  // Single-quote the endpoint (POSIX-escaping any embedded quotes) so it can
  // never break out of the curl argument. It is a constant today, but the
  // signature accepts any string — keep the shell construction injection-safe.
  const safeEndpoint = `'${endpoint.replace(/'/g, "'\\''")}'`;
  const script =
    `if ! command -v curl >/dev/null 2>&1; then echo NO_CURL; exit 0; fi; ` +
    `code=$(curl -so /dev/null -w '%{http_code}' ` +
    `--connect-timeout ${DOCKER_GPU_INFERENCE_PROBE_CONNECT_TIMEOUT_SECS} ` +
    `--max-time ${DOCKER_GPU_INFERENCE_PROBE_MAX_TIME_SECS} ${safeEndpoint} 2>/dev/null || echo 000); ` +
    `echo "HTTP_$code"`;
  let last: RuntimeProbeOutcome = {
    kind: "exec-failed",
    detail: "openshell sandbox exec did not run (sandbox unreachable or exec timed out)",
  };
  for (let attempt = 1; attempt <= DOCKER_GPU_INFERENCE_PROBE_MAX_ATTEMPTS; attempt++) {
    const result = deps.execInSandbox(sandboxName, script);
    if (result === null) {
      last = {
        kind: "exec-failed",
        detail: "openshell sandbox exec did not run (sandbox unreachable or exec timed out)",
      };
    } else {
      const out = (result.stdout || "").trim();
      if (out === "NO_CURL") return { kind: "no-curl" };
      const match = out.match(/HTTP_(\d{3})/);
      if (match) {
        const httpCode = match[1];
        // This gate is the #4509 runtime proof, so only a 2xx — the model list
        // actually returned through the proxy with injected auth — counts as
        // success. `000` is the reported failure (DNS / connection refused). A
        // 4xx (wrong provider route, or auth the proxy failed to inject) or 5xx
        // (local Ollama/vLLM backend down) means OpenClaw's real request would
        // fail too, so do NOT report it as reachable.
        if (/^2\d\d$/.test(httpCode)) return { kind: "ok", httpCode };
        last = {
          kind: "unreachable",
          detail:
            httpCode === "000"
              ? `${endpoint} returned HTTP 000 (DNS failure or connection refused)`
              : `${endpoint} returned HTTP ${httpCode} (inference route reached but not usable — provider route/auth misconfigured or the local backend is failing)`,
        };
      } else {
        // The exec ran but produced no sentinel — the sandbox runtime exec
        // path itself is broken (e.g. sandbox in Error, exec denied). Treat as
        // an exec failure, NOT a missing-curl soft-skip, so we never declare
        // success without actually exercising the runtime (#4509 review).
        const noise = (out || result.stderr || "").slice(0, 160);
        last = { kind: "exec-failed", detail: `unexpected sandbox exec output: ${noise}` };
      }
    }
    if (attempt < DOCKER_GPU_INFERENCE_PROBE_MAX_ATTEMPTS) {
      deps.sleep(DOCKER_GPU_INFERENCE_PROBE_RETRY_DELAY_SECS);
    }
  }
  return last;
}

/**
 * Post-ready local-inference reachability gate for the Docker-driver GPU path
 * (#4509). After the sandbox reaches Ready, prove the OpenClaw agent runtime
 * can actually reach the local inference route — from inside the sandbox's own
 * network namespace, the context the agent's LLM client uses — before
 * onboarding declares success. Otherwise an unreachable provider only surfaces
 * later as an opaque `ECONNREFUSED` / "LLM request failed: network connection
 * error" during the first agent prompt.
 *
 * Self-gates: returns `skipped` unless the GPU Docker-driver patch is active
 * for a local inference provider. Soft-skips (with a warning) only when the
 * sandbox image genuinely lacks `curl` — OpenClaw's HTTP client does not need
 * it, so a missing probe tool must not block an otherwise usable sandbox.
 */
export function verifyDockerGpuSandboxLocalInference(
  config: DockerGpuLocalInferenceConfig,
  provider: string | null | undefined,
  options: DockerGpuLocalInferenceOptions & {
    sandboxName: string;
    deps?: DockerGpuSandboxInferenceVerifyDeps;
  },
): DockerGpuSandboxInferenceVerification {
  if (
    !shouldApplyDockerGpuPatch(config, {
      dockerDriverGateway: options.dockerDriverGateway,
      env: options.env,
      platform: options.platform,
    })
  ) {
    return { status: "skipped", reason: "not-docker-gpu-patch" };
  }
  if (!isLocalInferenceProvider(provider)) {
    return { status: "skipped", reason: "not-local-provider" };
  }
  const endpoint = getSandboxRuntimeInferenceEndpoint(provider);
  if (!endpoint) {
    return { status: "skipped", reason: "no-runtime-endpoint" };
  }

  const deps = options.deps ?? {};
  const execInSandbox = deps.execInSandbox ?? executeSandboxCommandForVerification;
  const sleep =
    deps.sleep ??
    ((seconds: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
    });

  const outcome = probeSandboxRuntimeInference(options.sandboxName, endpoint, {
    execInSandbox,
    sleep,
  });

  if (outcome.kind === "ok") {
    return { status: "ok", provider, endpoint, httpCode: outcome.httpCode };
  }
  if (outcome.kind === "no-curl") {
    // Minimal/custom images (e.g. some `--from-dockerfile` bases) may not ship
    // curl. Soft-skip with a visible warning rather than fail onboarding; fall
    // back to console.warn so the skip reason is never silently dropped.
    const warn = options.log ?? ((message: string) => console.warn(message));
    warn(
      `  ⚠ Skipping GPU sandbox local inference reachability check: curl is not available in the sandbox (${options.sandboxName}).`,
    );
    return { status: "skipped", reason: "probe-tool-unavailable" };
  }

  const recovery =
    outcome.kind === "exec-failed"
      ? [
          "Confirm the sandbox is running and reachable:  openshell sandbox list",
          "Re-run onboarding; the sandbox runtime exec path did not respond.",
        ]
      : [
          "Ensure Ollama/vLLM is running and the OpenShell inference route is configured.",
          "Check the sandbox can reach inference.local (proxy/router up):",
          `  openshell sandbox exec -n ${options.sandboxName} -- curl -sS ${endpoint}`,
          "If a host firewall (e.g. UFW) blocks the Docker bridge, allow it so the sandbox",
          "  can reach the gateway/proxy, then re-run onboarding.",
          "Do not force NEMOCLAW_DOCKER_GPU_PATCH_NETWORK=host for local inference — the host",
          "  loopback is not reachable from the sandbox's isolated network namespace.",
        ];
  return {
    status: "failed",
    kind: outcome.kind === "exec-failed" ? "exec" : "unreachable",
    provider,
    endpoint,
    message:
      outcome.kind === "exec-failed"
        ? "The GPU sandbox runtime exec path did not respond, so local inference reachability could not be proven."
        : `The GPU sandbox runtime could not reach the local inference route ${endpoint} (the context OpenClaw's LLM client uses).`,
    detail: outcome.detail,
    recovery,
  };
}

/**
 * Print a failed sandbox-runtime inference verification result as actionable
 * operator output. Defaults to `console.error`.
 */
export function printDockerGpuSandboxInferenceVerificationFailure(
  verification: Extract<DockerGpuSandboxInferenceVerification, { status: "failed" }>,
  log: (message: string) => void = (message) => console.error(message),
): void {
  const providerLabel = getLocalProviderLabel(verification.provider) ?? verification.provider;
  log("");
  log("  Local inference reachability check failed for the GPU sandbox runtime.");
  log(`  ${verification.message}`);
  log(`  provider=${providerLabel}`);
  log(`  endpoint=${verification.endpoint}`);
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
  deps?: DockerGpuSandboxInferenceVerifyDeps;
};

/**
 * Post-readiness GPU sandbox verification orchestrator (kept out of the
 * ~12k-line onboard.ts entrypoint per the codebase-growth guardrail). Runs the
 * direct GPU proof, then — only when the Docker GPU patch is active for a local
 * inference provider — gates on local inference reachability from the sandbox
 * runtime (#4509). Exits the process with actionable output if either proof
 * fails.
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
  // GPU-patched sandbox to gate, so skip the local inference reachability gate.
  if (!options.useDockerGpuPatch) return;
  const verification = verifyDockerGpuSandboxLocalInference(config, provider, {
    sandboxName: options.sandboxName,
    dockerDriverGateway: options.dockerDriverGateway,
    env: options.env,
    platform: options.platform,
    log: options.log,
    deps: options.deps,
  });
  const log = options.log ?? console.log;
  if (verification.status === "ok") {
    log(
      `  ✓ GPU sandbox runtime reached local inference: ${verification.endpoint} (HTTP ${verification.httpCode})`,
    );
  } else if (verification.status === "failed") {
    // Route failure diagnostics through the caller-provided error sink so
    // wrappers / structured log collectors still see them; defaults to
    // console.error (onboard's stderr error channel).
    printDockerGpuSandboxInferenceVerificationFailure(
      verification,
      options.logError ?? ((message) => console.error(message)),
    );
    process.exit(1);
  }
}
