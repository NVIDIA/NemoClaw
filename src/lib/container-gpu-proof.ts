// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Escape untrusted GPU names without allowing terminal-control sequences. */
export function escapeGpuNameForTerminal(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const isC0 = codePoint <= 0x1f;
      const isDeleteOrC1 = codePoint >= 0x7f && codePoint <= 0x9f;
      const isLineSeparator = codePoint === 0x2028 || codePoint === 0x2029;
      const isFormatControl = /^\p{Cf}$/u.test(character);
      if (!isC0 && !isDeleteOrC1 && !isLineSeparator && !isFormatControl) return character;
      return "\\u{" + codePoint.toString(16).padStart(4, "0") + "}";
    })
    .join("");
}

// Result of a bounded Docker or Podman CUDA proof. `passed` is true only when a
// real CUDA workload (not just nvidia-smi) succeeded. This distinguishes a
// genuine Windows-on-Arm N1X GPU from the Snapdragon nvidia-smi shim, which has
// no usable NVIDIA device (#3988/#4424/#4565).
export interface ContainerGpuProofResult {
  /** Qualified runtime provider that executed the proof. */
  readonly providerId: string;
  passed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  diagnostic: string;
  /** Capacity reported from the same container-visible device that ran the CUDA workload. */
  verifiedCapacity?: {
    totalMemoryMB: number;
    availableMemoryMB: number;
  };
  cleanup?: {
    readonly resourceName: string;
    readonly status: "absent" | "removed" | "failed";
  };
}

/** Minimal provider-bound proof state safe to project into readiness reports. */
export type ContainerGpuProofStatus = Readonly<
  Pick<ContainerGpuProofResult, "providerId" | "passed">
>;

// Optional accept-path used by `detectGpu()` when an ARM64 Linux host reports a
// denylisted `JMJWOA-Generic-*` placeholder. The prover returns `null` when the
// host is not an ARM64 Linux proof candidate, preserving the fail-closed
// default; otherwise it returns provider-bound evidence.
export type Arm64ContainerGpuProver = (gpuNames: string[]) => ContainerGpuProofResult | null;

// Immutable multi-architecture CUDA vectorAdd image and fixed command shared
// by provider-neutral execution and Docker-specific operator remediation.
export const NVIDIA_CONTAINER_GPU_PROOF_IMAGE =
  "nvcr.io/nvidia/k8s/cuda-sample@sha256:7c7540bdf1f942d4fb6db97069fd6c289471b54ac29e3c7fcdf914cf77af7d41";
export const NVIDIA_CONTAINER_GPU_PROOF_SCRIPT =
  'set -eu; /cuda-samples/sample; memory="$(nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits 2>/dev/null || true)"; printf "NEMOCLAW_GPU_MEMORY_MIB=%s\\n" "$memory"';
