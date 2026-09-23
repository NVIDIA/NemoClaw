// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  escapeGpuNameForTerminal,
  NVIDIA_CONTAINER_GPU_PROOF_IMAGE,
  NVIDIA_CONTAINER_GPU_PROOF_SCRIPT,
  type Arm64ContainerGpuProver,
  type ContainerGpuProofResult,
} from "../../container-gpu-proof";
import type { RuntimeProviderBundle, RuntimeProviderOwnedContainerResource } from "./contract";

// This prover only runs on ARM64. The immutable vectorAdd manifest contains
// both linux/amd64 and linux/arm64 images, and its ARM64 image ships a genuine
// aarch64 CUDA binary. A real kernel execution is the device-usability proof;
// the same container then reports capacity for the device namespace it proved.
const NVIDIA_CONTAINER_GPU_CAPACITY_MARKER = "NEMOCLAW_GPU_MEMORY_MIB=";

// The proof may pull the image on first use. Keep the historical environment
// variable as a compatibility surface while the execution owner is provider-neutral.
const NVIDIA_CONTAINER_GPU_PROOF_DEFAULT_TIMEOUT_MS = 180_000;
const NVIDIA_CONTAINER_GPU_PROOF_MAX_TIMEOUT_MS = 900_000;
const NVIDIA_CONTAINER_GPU_PROOF_CLEANUP_TIMEOUT_MS = 15_000;
const NVIDIA_CONTAINER_GPU_PROOF_OWNERSHIP = Object.freeze({
  label: "com.nvidia.nemoclaw.gpu-proof",
  value: "true",
});

export function containerGpuProofTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS);
  return Number.isSafeInteger(raw) && raw > 0
    ? Math.min(raw, NVIDIA_CONTAINER_GPU_PROOF_MAX_TIMEOUT_MS)
    : NVIDIA_CONTAINER_GPU_PROOF_DEFAULT_TIMEOUT_MS;
}

export interface Arm64ContainerGpuProverDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  resolveRuntimeProvider?: () => RuntimeProviderBundle;
  runProof?: (provider: RuntimeProviderBundle, timeoutMs: number) => ContainerGpuProofResult;
  log?: (message: string) => void;
  randomUUID?: () => string;
}

function resolveRuntimeProvider(): RuntimeProviderBundle {
  return (
    require("./selection") as typeof import("./selection")
  ).resolveConfiguredRuntimeProvider();
}

export function parseContainerGpuProofCapacity(
  output: string,
): ContainerGpuProofResult["verifiedCapacity"] | null {
  const firstMarker = output.indexOf(NVIDIA_CONTAINER_GPU_CAPACITY_MARKER);
  if (firstMarker < 0 || firstMarker !== output.lastIndexOf(NVIDIA_CONTAINER_GPU_CAPACITY_MARKER)) {
    return null;
  }
  const value = output.slice(firstMarker + NVIDIA_CONTAINER_GPU_CAPACITY_MARKER.length).trim();
  const match = /^([1-9][0-9]*)\s*,\s*([0-9]+)$/u.exec(value);
  if (!match) return null;
  const totalMemoryMB = Number(match[1]);
  const availableMemoryMB = Number(match[2]);
  if (
    !Number.isSafeInteger(totalMemoryMB) ||
    !Number.isSafeInteger(availableMemoryMB) ||
    availableMemoryMB > totalMemoryMB
  ) {
    return null;
  }
  return { totalMemoryMB, availableMemoryMB };
}

// An exec-format error on this ARM64-only path is a proof-image defect, not a
// missing-GPU signal, so it receives a distinct operator diagnostic.
export function isExecFormatErrorDiagnostic(diagnostic: string | null | undefined): boolean {
  return typeof diagnostic === "string" && /exec format error/i.test(diagnostic);
}

function runRuntimeProviderGpuProof(
  provider: RuntimeProviderBundle,
  timeoutMs: number,
  randomUUIDImpl: () => string = randomUUID,
): ContainerGpuProofResult {
  const resource = {
    name: `nemoclaw-gpu-proof-${randomUUIDImpl()}`,
    ownership: NVIDIA_CONTAINER_GPU_PROOF_OWNERSHIP,
  };
  const containerEngine = provider.containerEngine;
  const nvidiaContainer = containerEngine.supported ? containerEngine.nvidiaContainer : undefined;
  if (!containerEngine.supported || !nvidiaContainer) {
    return {
      providerId: provider.identity.id,
      passed: false,
      timedOut: false,
      exitCode: null,
      diagnostic: "configured runtime provider has no NVIDIA container proof capability",
    };
  }
  const cleanupContainer = (
    target: RuntimeProviderOwnedContainerResource,
    observation: "immediate" | "until-deadline",
  ): NonNullable<ContainerGpuProofResult["cleanup"]> => {
    try {
      const cleanup = nvidiaContainer.cleanup("host-local-inference", target, {
        timeoutMs: NVIDIA_CONTAINER_GPU_PROOF_CLEANUP_TIMEOUT_MS,
        observation,
      });
      return {
        resourceName: target.name,
        ...(observation === "until-deadline" && cleanup.status === "absent"
          ? { status: "failed" as const }
          : cleanup),
      };
    } catch {
      return { resourceName: target.name, status: "failed" };
    }
  };
  try {
    const result = nvidiaContainer.capture(
      "host-local-inference",
      {
        image: NVIDIA_CONTAINER_GPU_PROOF_IMAGE,
        entrypoint: "/bin/sh",
        command: ["-c", NVIDIA_CONTAINER_GPU_PROOF_SCRIPT],
        resource,
      },
      timeoutMs,
    );
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const diagnosticSource = result.stderr || result.stdout;
    const workloadPassed = result.status === 0 && !timedOut && result.error === undefined;
    const verifiedCapacity = workloadPassed ? parseContainerGpuProofCapacity(result.stdout) : null;
    const cleanup = cleanupContainer(
      resource,
      timedOut || result.error !== undefined ? "until-deadline" : "immediate",
    );
    const passed = workloadPassed && cleanup.status !== "failed";
    return {
      providerId: provider.identity.id,
      passed,
      timedOut,
      exitCode: result.status,
      diagnostic: diagnosticSource.slice(0, 300),
      ...(passed && verifiedCapacity ? { verifiedCapacity } : {}),
      ...(cleanup ? { cleanup } : {}),
    };
  } catch (error) {
    return {
      providerId: provider.identity.id,
      passed: false,
      timedOut: false,
      exitCode: null,
      diagnostic:
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      cleanup: cleanupContainer(resource, "until-deadline"),
    };
  }
}

// Build the ARM64 proof consumed by GPU detection. The selected runtime bundle
// owns all provider-specific invocation details; this orchestration never
// branches on Docker or Podman and trusts neither the host GPU name nor host
// memory as proof of usable container capacity.
export function createArm64ContainerGpuProver(
  deps: Arm64ContainerGpuProverDeps = {},
): Arm64ContainerGpuProver {
  const log = deps.log ?? ((message: string) => console.log(message));
  const resolveProvider = deps.resolveRuntimeProvider ?? resolveRuntimeProvider;
  const runProof =
    deps.runProof ??
    ((provider, timeoutMs) =>
      runRuntimeProviderGpuProof(provider, timeoutMs, deps.randomUUID ?? randomUUID));
  return function proveArm64ContainerGpu(gpuNames: string[]): ContainerGpuProofResult | null {
    const platform = deps.platform ?? process.platform;
    const arch = deps.arch ?? process.arch;
    if (platform !== "linux" || arch !== "arm64") return null;
    let provider: RuntimeProviderBundle;
    try {
      provider = resolveProvider();
    } catch {
      log("  ✗ Configured container runtime could not start the bounded GPU proof.");
      return null;
    }
    const names =
      gpuNames.filter(Boolean).map(escapeGpuNameForTerminal).join(", ") || "generic ARM64 GPU";
    log(
      `  Running bounded ${provider.identity.displayName} GPU proof for ${names} (may pull a CUDA sample image)...`,
    );
    const result = {
      ...runProof(provider, containerGpuProofTimeoutMs(deps.env)),
      providerId: provider.identity.id,
    };
    if (result.passed) {
      log(`  ✓ ${provider.identity.displayName} GPU proof passed; trusting the reported GPU.`);
      if (result.verifiedCapacity) {
        log(
          `  ✓ ${provider.identity.displayName} GPU capacity proof: ${String(result.verifiedCapacity.availableMemoryMB)} MiB available of ${String(result.verifiedCapacity.totalMemoryMB)} MiB.`,
        );
      } else {
        log(
          `  ! ${provider.identity.displayName} GPU capacity proof was unavailable; compute-intensive Ollama models remain disabled.`,
        );
      }
    } else if (result.timedOut) {
      log(
        `  ✗ ${provider.identity.displayName} GPU proof timed out; treating GPU as unproven (CPU fallback).`,
      );
      log(
        "    Rerun with --no-gpu to skip GPU passthrough, or raise NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS.",
      );
    } else if (isExecFormatErrorDiagnostic(result.diagnostic)) {
      log(
        `  ✗ ${provider.identity.displayName} GPU proof could not run: CUDA sample image architecture does not`,
      );
      log(
        "    match this host (exec format error). This is a proof-image issue, not a missing GPU.",
      );
      log(
        "    Rerun with --no-gpu to skip GPU passthrough, or report this so the proof image can be fixed.",
      );
    } else {
      log(
        `  ✗ ${provider.identity.displayName} GPU proof failed; treating GPU as unproven (CPU fallback).`,
      );
      log("    Rerun with --no-gpu to skip GPU passthrough.");
    }
    if (result.cleanup?.status === "failed") {
      log(
        `    Cleanup could not prove absence or removal of provider-owned container ${result.cleanup.resourceName}; verify that exact container is absent, or remove it before retrying.`,
      );
    }
    return result;
  };
}
