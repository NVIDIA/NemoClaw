// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import { dockerInfoFormat as defaultDockerInfoFormat } from "../adapters/docker";
import type { Arm64WslDockerDesktopGpuProver, DockerGpuProofResult } from "../inference/gpu-trust";

const WSL_DOCKER_DESKTOP_DETECTION_TIMEOUT_MS = 30_000;
// This prover only ever runs on ARM64 (see `createArm64WslDockerDesktopGpuProver`),
// so the proof image MUST ship a real aarch64 CUDA binary. The older
// `cuda-sample:nbody` image is unusable here: its arm64 manifest entry actually
// contains an x86-64 ELF, so on the N1X Windows-ARM target it fails with
// `exec /cuda-samples/sample: exec format error` (#4565). `vectoradd-cuda12.5.0`
// ships a genuine aarch64 binary and runs a real CUDA kernel (device alloc +
// add + result verification), which is a strong usability proof that still
// fails closed on the Snapdragon nvidia-smi shim (no usable CUDA device, #3988).
// The image's entrypoint runs vectorAdd directly, so no trailing args are needed.
export const WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND =
  "docker run --rm --gpus all nvcr.io/nvidia/k8s/cuda-sample:vectoradd-cuda12.5.0";

// The proof runs a real CUDA workload and may first pull the CUDA sample image,
// so it is bounded generously (3 min) rather than with the 30s detection
// timeout. Operators on slow links can override via
// NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS. The timeout is the safety bound that keeps
// onboarding from hanging if Docker Desktop GPU passthrough stalls.
const WSL_DOCKER_DESKTOP_GPU_PROOF_DEFAULT_TIMEOUT_MS = 180_000;

export function wslDockerDesktopGpuProofTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : WSL_DOCKER_DESKTOP_GPU_PROOF_DEFAULT_TIMEOUT_MS;
}

// Source-of-truth for this compatibility branch: Docker Desktop-backed WSL can
// advertise Docker CDI directories while the WSL distro cannot see a usable
// nvidia.com/gpu CDI spec. Retire this workaround only after Docker Desktop
// exposes usable nvidia.com/gpu CDI specs into WSL, or after OpenShell owns a
// Docker Desktop WSL GPU path that no longer relies on host-visible CDI specs.
export const WSL_DOCKER_DESKTOP_GPU_COMPATIBILITY_REMOVAL_CONDITION =
  "Remove this compatibility path when Docker Desktop exposes usable nvidia.com/gpu CDI specs into WSL, or OpenShell no longer requires host-visible CDI specs for Docker Desktop WSL GPU passthrough.";

export type WslDockerDesktopStatus = "docker-desktop" | "not-docker-desktop" | "unknown";

export type WslDockerDesktopHost = {
  isWsl: boolean;
  runtime?: string | null;
};

export type WslDockerDesktopDetectionDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  procVersion?: string;
  readFileImpl?: (filePath: string, encoding: BufferEncoding) => string;
  dockerInfoFormat?: (format: string, opts?: Record<string, unknown>) => string;
};

export type WslDockerDesktopGpuCompatibilityAction = {
  id: "wsl_docker_desktop_gpu_compatibility";
  title: string;
  kind: "info";
  reason: string;
  commands: string[];
  blocking: false;
};

export function isWslDockerDesktopRuntime(host: WslDockerDesktopHost): boolean {
  return host.isWsl && host.runtime === "docker-desktop";
}

function detectWsl(deps: WslDockerDesktopDetectionDeps): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return false;
  const env = deps.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  const release = deps.release ?? os.release();
  if (/microsoft/i.test(release)) return true;
  const procVersion =
    deps.procVersion ??
    (() => {
      try {
        const readFileImpl =
          deps.readFileImpl ??
          ((filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding));
        return readFileImpl("/proc/version", "utf-8");
      } catch {
        return "";
      }
    })();
  return /microsoft/i.test(procVersion);
}

function detectDockerDesktopRuntime(deps: WslDockerDesktopDetectionDeps): WslDockerDesktopStatus {
  const dockerInfo = deps.dockerInfoFormat ?? defaultDockerInfoFormat;
  try {
    const output = String(
      dockerInfo("{{json .OperatingSystem}}", {
        ignoreError: true,
        timeout: WSL_DOCKER_DESKTOP_DETECTION_TIMEOUT_MS,
      }),
    ).trim();
    if (!output || output === "<no value>") return "unknown";
    return /^"?docker desktop\b/i.test(output) ? "docker-desktop" : "not-docker-desktop";
  } catch {
    return "unknown";
  }
}

export function detectWslDockerDesktopStatus(
  deps: WslDockerDesktopDetectionDeps = {},
): WslDockerDesktopStatus {
  if (!detectWsl(deps)) return "not-docker-desktop";
  return detectDockerDesktopRuntime(deps);
}

export function wslDockerDesktopGpuCompatibilityRemediationLines(
  status: WslDockerDesktopStatus,
): string[] | null {
  if (status === "docker-desktop") {
    return [
      "Docker Desktop WSL detected; NemoClaw uses Docker --gpus compatibility instead of CDI spec validation.",
      "If sandbox GPU setup later fails, verify from WSL:",
      `  ${WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND}`,
      "Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.",
    ];
  }
  if (status === "unknown") {
    return [
      "WSL detected, but NemoClaw could not determine whether Docker is Docker Desktop or native Docker Engine.",
      "If using Docker Desktop, confirm Settings > Resources > WSL integration is enabled for this distro, restart Docker Desktop, and verify:",
      `  ${WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND}`,
      "If using native Docker Engine inside WSL, install/configure NVIDIA Container Toolkit CDI, then restart Docker.",
      "Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.",
    ];
  }
  return null;
}

export type Arm64WslDockerDesktopGpuProverDeps = WslDockerDesktopDetectionDeps & {
  arch?: string;
  detectWslDockerDesktopStatus?: (deps: WslDockerDesktopDetectionDeps) => WslDockerDesktopStatus;
  runProof?: (argv: string[], timeoutMs: number) => DockerGpuProofResult;
  log?: (message: string) => void;
};

// Split the fixed proof command constant into an argv. The command is repo-
// controlled and contains no quoting, so a whitespace split is exact and avoids
// routing the bounded proof through a shell.
function wslDockerDesktopGpuProofArgv(): string[] {
  return WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND.split(/\s+/).filter(Boolean);
}

// Docker reports an architecture mismatch (proof image built for a different
// CPU than the host) as `exec ...: exec format error`. On this ARM64-only path
// that means the proof image's binary is not aarch64 — a packaging/image bug,
// not a "no GPU" condition — so we must not let it read as a missing GPU (#4565).
export function isExecFormatErrorDiagnostic(diagnostic: string | null | undefined): boolean {
  return typeof diagnostic === "string" && /exec format error/i.test(diagnostic);
}

function runWslDockerDesktopGpuProof(argv: string[], timeoutMs: number): DockerGpuProofResult {
  try {
    // Lazy require: keeps this onboard module from statically pulling in the
    // runner (and its transitive platform require) at import time.
    const { runCaptureEx } = require("../runner") as typeof import("../runner");
    const result = runCaptureEx(argv, { timeout: timeoutMs });
    // Docker daemon errors ("could not select device driver") and CUDA-sample
    // failures ("no CUDA-capable device is detected") are written to stderr, so
    // prefer it for the diagnostic and fall back to stdout (vectorAdd output).
    const diagnosticSource = result.stderr || result.stdout;
    return {
      passed: result.exitCode === 0 && !result.timedOut,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      diagnostic: diagnosticSource.slice(0, 300),
    };
  } catch (err) {
    return {
      passed: false,
      timedOut: false,
      exitCode: null,
      diagnostic: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    };
  }
}

// Build the ARM64 WSL Docker Desktop GPU prover consumed by `detectGpu()` for
// denylisted `JMJWOA-Generic-*` names (#4565). Returns `null` for any host that
// is not ARM64 Linux on Docker Desktop-backed WSL, so the #3988/#4424 fail-
// closed default is preserved everywhere else. When the host IS a candidate it
// runs one bounded Docker `--gpus` CUDA workload (the aarch64 vectorAdd sample):
// a real N1X GPU passes, while the Snapdragon nvidia-smi shim — which has no
// usable CUDA device — cannot, so the placeholder name alone is never trusted.
export function createArm64WslDockerDesktopGpuProver(
  deps: Arm64WslDockerDesktopGpuProverDeps = {},
): Arm64WslDockerDesktopGpuProver {
  const log = deps.log ?? ((message: string) => console.log(message));
  const detectStatus = deps.detectWslDockerDesktopStatus ?? detectWslDockerDesktopStatus;
  const runProof = deps.runProof ?? runWslDockerDesktopGpuProof;
  return function proveArm64WslDockerDesktopGpu(gpuNames: string[]): DockerGpuProofResult | null {
    const platform = deps.platform ?? process.platform;
    const arch = deps.arch ?? process.arch;
    if (platform !== "linux" || arch !== "arm64") return null;
    if (detectStatus(deps) !== "docker-desktop") return null;
    const names = gpuNames.filter(Boolean).join(", ") || "generic ARM64 GPU";
    log(
      `  Running bounded Docker Desktop WSL GPU proof for ${names} (may pull a CUDA sample image)...`,
    );
    log(`    ${WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND}`);
    const result = runProof(
      wslDockerDesktopGpuProofArgv(),
      wslDockerDesktopGpuProofTimeoutMs(deps.env),
    );
    if (result.passed) {
      log("  ✓ Docker Desktop WSL GPU proof passed; trusting the reported GPU.");
    } else if (result.timedOut) {
      log("  ✗ Docker Desktop WSL GPU proof timed out; treating GPU as unproven (CPU fallback).");
      log(
        "    Rerun with --no-gpu to skip GPU passthrough, or raise NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS.",
      );
    } else if (isExecFormatErrorDiagnostic(result.diagnostic)) {
      // The proof binary's architecture did not match the host. This is an image
      // problem, not a GPU problem, so call it out explicitly rather than letting
      // the host fall back to CPU as if no GPU were present (#4565).
      log(
        "  ✗ Docker Desktop WSL GPU proof could not run: CUDA sample image architecture does not",
      );
      log(
        "    match this host (exec format error). This is a proof-image issue, not a missing GPU.",
      );
      log(
        "    Rerun with --no-gpu to skip GPU passthrough, or report this so the proof image can be fixed.",
      );
    } else {
      log("  ✗ Docker Desktop WSL GPU proof failed; treating GPU as unproven (CPU fallback).");
      log("    Rerun with --no-gpu to skip GPU passthrough.");
    }
    return result;
  };
}

export function wslDockerDesktopGpuCompatibilityAction(): WslDockerDesktopGpuCompatibilityAction {
  return {
    id: "wsl_docker_desktop_gpu_compatibility",
    title: "Use Docker Desktop WSL GPU compatibility path",
    kind: "info",
    reason:
      "Docker Desktop is configured for CDI device injection (CDISpecDirs is set) but no " +
      "nvidia.com/gpu CDI spec is visible from WSL. On Docker Desktop-backed WSL, NemoClaw " +
      "uses Docker's `--gpus` compatibility path instead of trying to repair Linux host CDI " +
      "from inside the WSL distro.",
    commands: [
      `If sandbox GPU setup later fails, verify Docker Desktop GPU support from WSL with \`${WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND}\`.`,
      "Rerun with `--no-gpu` to skip GPU passthrough.",
    ],
    blocking: false,
  };
}
