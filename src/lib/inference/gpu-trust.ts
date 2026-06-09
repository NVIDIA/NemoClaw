// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");

// Accept a name as NVIDIA when it advertises the vendor explicitly or matches
// a known NVIDIA product family. The caller must still cross-check against
// `detectNvidiaPlatform()` and the trust-tier gate before trusting the
// nvidia-smi output — the name alone is insufficient because both real DGX
// Spark and the observed Windows-on-ARM WSL2 nvidia-smi shim publish
// placeholder names like "JMJWOA-Generic-GPU".
const NVIDIA_GPU_NAME_PATTERN =
  /\bNVIDIA\b|\b(GeForce|Tesla|Quadro|RTX|GTX|TITAN|H100|H200|A100|A40|A10|L40|L4|GB1\d|GB200|GB300|Grace[\s_-]+Hopper)\b/i;

// Placeholder names observed on the Windows-on-ARM WSL2 nvidia-smi shim AND
// on legitimate NVIDIA unified-memory hardware. The prefix match catches the
// GPU and NPU placeholder variants the shim emits, plus any future suffix
// without a code change. Even with an `NVIDIA ` vendor prefix the name alone
// is not sufficient — the caller must cross-check `detectNvidiaPlatform()`.
const NVIDIA_GPU_NAME_DENYLIST_PATTERN = /\bJMJWOA-Generic-/i;

const NVIDIA_DRIVER_PROC_PATH = "/proc/driver/nvidia";

export function isDenylistedNvidiaGpuName(name: string): boolean {
  return NVIDIA_GPU_NAME_DENYLIST_PATTERN.test(name);
}

// Result of a bounded Docker `--gpus` CUDA proof. `passed` is true only when a
// real CUDA workload (not just nvidia-smi) succeeded — that is the signal that
// distinguishes a genuine Windows-ARM N1X + WSL2 + Docker Desktop GPU (#4565)
// from the Windows-on-ARM Snapdragon nvidia-smi shim (#3988/#4424), which has
// no usable NVIDIA device and so cannot pass the workload.
export interface DockerGpuProofResult {
  passed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  diagnostic: string;
}

// Optional accept-path used by `detectGpu()` when an ARM64 Linux host reports a
// denylisted `JMJWOA-Generic-*` placeholder. The prover returns `null` when the
// host is not a proof candidate (not ARM64 WSL Docker Desktop), preserving the
// #3988 fail-closed default; otherwise it returns the bounded Docker GPU proof
// outcome so a passing real GPU can be trusted without trusting the name alone.
export type Arm64WslDockerDesktopGpuProver = (gpuNames: string[]) => DockerGpuProofResult | null;

export function isPlausibleNvidiaGpuName(name: string): boolean {
  return !!name && !isDenylistedNvidiaGpuName(name) && NVIDIA_GPU_NAME_PATTERN.test(name);
}

// Trust-tier check used after the name denylist on hosts whose firmware does
// not vouch for an NVIDIA platform.
//
// Source boundary: NemoClaw cannot fix the Windows-on-ARM WSL2 nvidia-smi shim
// that reports JMJWOA placeholder devices for non-NVIDIA hardware, so the CLI
// must fail closed before enabling gateway or sandbox GPU passthrough.
//
// Permanent policy: ARM64 Linux hosts with generic firmware must expose the
// NVIDIA kernel-driver proc interface before NemoClaw trusts nvidia-smi output.
// Non-Linux hosts and non-ARM64 Linux keep the historical nvidia-smi trust path
// because the observed false-positive source is WoA/ARM64-specific; broaden
// this gate only if a new spoofing source is reproduced with a regression test.
export function nvidiaHostLooksGenuine(): boolean {
  if (process.platform !== "linux") return true;
  if (process.arch !== "arm64") return true;
  try {
    return fs.existsSync(NVIDIA_DRIVER_PROC_PATH);
  } catch {
    return false;
  }
}
