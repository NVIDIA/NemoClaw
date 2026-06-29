// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerInfoFormat } from "../adapters/docker";
import type { GpuDetection } from "../inference/nim";
import type { SandboxGpuProofResult } from "../state/registry";
import { findReadableNvidiaCdiSpecFiles, getDockerCdiSpecDirs } from "./docker-cdi";
import type { SandboxGpuConfig, SandboxGpuFlag } from "./sandbox-gpu-mode";
import {
  detectWslDockerDesktopStatus,
  type WslDockerDesktopDetectionDeps,
  type WslDockerDesktopStatus,
  wslDockerDesktopGpuCompatibilityRemediationLines,
} from "./wsl-docker-desktop-gpu";

export { formatSandboxGpuPassthroughNote } from "./sandbox-gpu-notes";

const SANDBOX_GPU_PREFLIGHT_TIMEOUT_MS = 30_000;

export type SandboxGpuPreflightDeps = WslDockerDesktopDetectionDeps & {
  getDockerCdiSpecDirs?: () => string[];
  findReadableNvidiaCdiSpecFiles?: (dirs: string[]) => string[];
};

export interface SandboxGpuFlagOptions {
  sandboxGpu?: SandboxGpuFlag;
  gpu?: boolean;
  noGpu?: boolean;
}

export function resolveSandboxGpuFlagFromOptions(opts: SandboxGpuFlagOptions): SandboxGpuFlag {
  const requestedGpuPassthrough = opts.gpu === true;
  const optedOutGpuPassthrough = opts.noGpu === true;
  const sandboxGpuFlag = opts.sandboxGpu ?? null;
  if (requestedGpuPassthrough && optedOutGpuPassthrough) {
    console.error("  --gpu and --no-gpu cannot both be set.");
    process.exit(1);
  }
  if (
    (requestedGpuPassthrough && sandboxGpuFlag === "disable") ||
    (optedOutGpuPassthrough && sandboxGpuFlag === "enable")
  ) {
    console.error("  --gpu/--no-gpu conflict with the sandbox GPU flags.");
    process.exit(1);
  }
  if (sandboxGpuFlag) return sandboxGpuFlag;
  if (requestedGpuPassthrough) return "enable";
  if (optedOutGpuPassthrough) return "disable";
  return null;
}

// Jetson/Tegra CUDA failures are usually device/group permission issues rather
// than CDI/runtime misconfiguration: the sandbox sees the GPU but the agent
// user lacks access to the Tegra device nodes. Surface the concrete devices and
// groups so the user can fix the recreate rather than seeing a bare "enabled"
// status that hides an unusable GPU (#4231).
export function jetsonGpuProofRemediationLines(): string[] {
  return [
    "Jetson/Tegra CUDA proof did not pass. CUDA needs access to the Tegra device",
    "nodes; confirm the sandbox propagates them and the agent user's groups:",
    "  ls -l /dev/nvmap /dev/nvhost-* (must be readable by the sandbox)",
    "  add the host video/render groups via --group-add when recreating",
    "Then recreate the sandbox, or force CPU behavior with NEMOCLAW_SANDBOX_GPU=0.",
  ];
}

export function sandboxGpuRemediationLines(
  options: { wslDockerDesktop?: boolean; wslDockerDesktopStatus?: WslDockerDesktopStatus } = {},
): string[] {
  const status =
    options.wslDockerDesktopStatus ??
    (options.wslDockerDesktop ? "docker-desktop" : "not-docker-desktop");
  const wslRemediationLines = wslDockerDesktopGpuCompatibilityRemediationLines(status);
  if (wslRemediationLines) return wslRemediationLines;
  return [
    "Install/configure NVIDIA Container Toolkit CDI, then restart Docker:",
    "  sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml",
    "  sudo systemctl restart docker",
    "Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.",
  ];
}

export function exitOnSandboxGpuConfigErrors(config: SandboxGpuConfig): void {
  if (config.errors.length > 0) {
    console.error("");
    for (const error of config.errors) console.error(`  ✗ ${error}`);
    process.exit(1);
  }
}

export function parseDockerRuntimeNames(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw || raw === "<no value>") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry || "").trim()).filter(Boolean);
    }
    if (parsed && typeof parsed === "object") {
      return Object.keys(parsed)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to the plain-text parser below.
  }
  return raw
    .split(/[\s,{}":]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function dockerNvidiaRuntimeAvailable(deps: SandboxGpuPreflightDeps = {}): boolean {
  const dockerInfo = deps.dockerInfoFormat ?? dockerInfoFormat;
  try {
    const runtimeOutput = dockerInfo("{{json .Runtimes}}", {
      ignoreError: true,
      timeout: SANDBOX_GPU_PREFLIGHT_TIMEOUT_MS,
    });
    return parseDockerRuntimeNames(runtimeOutput).includes("nvidia");
  } catch {
    return false;
  }
}

function validateJetsonSandboxGpuPreflight(deps: SandboxGpuPreflightDeps): void {
  if (!dockerNvidiaRuntimeAvailable(deps)) {
    console.error("");
    console.error("  ✗ Docker NVIDIA runtime was not detected for Jetson/Tegra sandbox GPU.");
    console.error("    Jetson sandbox GPU uses NVIDIA Container Runtime semantics, not CDI.");
    console.error(
      "    Install/configure NVIDIA Container Toolkit for Docker, then restart Docker:",
    );
    console.error("      sudo nvidia-ctk runtime configure --runtime=docker");
    console.error("      sudo systemctl restart docker");
    console.error("    Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.");
    process.exit(1);
  }
  console.log("  ✓ Docker NVIDIA runtime detected for Jetson/Tegra sandbox GPU");
}

export interface DirectSandboxGpuVerifierDeps extends WslDockerDesktopDetectionDeps {
  runOpenshell(
    args: string[],
    opts?: Record<string, unknown>,
  ): { status?: number | null; stdout?: unknown; stderr?: unknown };
  buildDirectSandboxGpuProofCommands?: (sandboxName: string) => Array<{
    id?: string;
    args: string[];
    label: string;
    optional?: boolean;
  }>;
  compactText(value: string): string;
  redact(value: unknown): string;
  // Host firmware platform resolver, used to choose Jetson-specific remediation
  // when a CUDA proof fails. Defaults to the live `nim.detectNvidiaPlatform()`
  // so onboarding does not have to thread the platform through. Injected in
  // tests to exercise the Jetson path without Jetson firmware.
  detectNvidiaPlatform?: () => GpuDetection["platform"] | null;
}

// The proof whose result decides CUDA usability. `cuInit(0)` via libcuda is the
// authoritative usability signal (it actually initializes the CUDA driver), so
// a clean pass means "verified" and a run that reaches the driver and fails
// means "failed" rather than merely "unverified".
const CUDA_USABILITY_PROOF_ID = "cuda-init";
// Capture the cuInit(0) return code so we can require it to be 0 for a verified
// result. Matching only the marker text is not enough: a wrapper that swallows
// the probe's non-zero exit but still prints `cuInit(0)=<err>` would otherwise
// read as verified for an unusable GPU (#4231).
const CUDA_INIT_RESULT_PATTERN = /cuInit\(0\)=(-?\d+)/;

export type VerifyDirectSandboxGpu = (
  sandboxName: string,
  hostGpuPlatform?: GpuDetection["platform"] | null,
) => SandboxGpuProofResult;

export function createDirectSandboxGpuVerifier(
  deps: DirectSandboxGpuVerifierDeps,
): VerifyDirectSandboxGpu {
  return function verifyDirectSandboxGpu(
    sandboxName: string,
    hostGpuPlatform?: GpuDetection["platform"] | null,
  ): SandboxGpuProofResult {
    console.log("  Verifying direct sandbox GPU access...");
    const resolvedPlatform =
      hostGpuPlatform !== undefined
        ? hostGpuPlatform
        : (deps.detectNvidiaPlatform ?? require("../inference/nim").detectNvidiaPlatform)();
    const buildProofCommands =
      deps.buildDirectSandboxGpuProofCommands ??
      require("./initial-policy").buildDirectSandboxGpuProofCommands;
    let cudaVerified = false;
    // A CUDA-usability proof that reached the driver and failed (vs one that
    // could not run at all). Records the proof that determines "failed" status.
    let cudaFailure: { label: string; detail: string } | null = null;
    for (const proof of buildProofCommands(sandboxName)) {
      const result = deps.runOpenshell(proof.args, {
        ignoreError: true,
        suppressOutput: true,
        timeout: 30_000,
      });
      // Test the cuInit marker against the FULL combined output; truncation to
      // 300 chars is only for display/storage, so a verbose proof cannot push
      // the marker past the cutoff and silently downgrade the classification.
      const rawOutput = deps.redact(`${result.stderr || ""} ${result.stdout || ""}`);
      const cudaInitMatch = rawOutput.match(CUDA_INIT_RESULT_PATTERN);
      const cudaInitRan = cudaInitMatch !== null;
      // Only `cuInit(0)=0` proves usability; any other return code means the
      // driver was reached but initialization failed.
      const cudaInitSucceeded = cudaInitMatch?.[1] === "0";
      const diagnostic = deps.compactText(rawOutput).slice(0, 300);
      if (result.status === 0) {
        console.log(`  ✓ GPU proof passed: ${proof.label}`);
        if (proof.id === CUDA_USABILITY_PROOF_ID && cudaInitRan) {
          // Require the cuInit(0)=0 marker on success too, symmetric with the
          // failure path: a zero exit without driver initialization, or a
          // wrapper that swallowed a non-zero exit but still printed a non-zero
          // cuInit code, must not read as verified — treat the latter as failed.
          if (cudaInitSucceeded) {
            cudaVerified = true;
          } else {
            cudaFailure = { label: proof.label, detail: diagnostic };
          }
        }
        continue;
      }
      if (proof.optional !== true) {
        // Required proof (e.g. the sandbox-exec wrapper itself): keep the
        // historical hard-fail so onboarding aborts and rolls back.
        console.error(`  ✗ GPU proof failed: ${proof.label}`);
        if (diagnostic) console.error(`    ${diagnostic}`);
        for (const line of sandboxGpuRemediationLines({
          wslDockerDesktopStatus: detectWslDockerDesktopStatus(deps),
        })) {
          console.error(`    ${line}`);
        }
        const statusText = String(result.status || 1);
        const diagnosticSuffix = diagnostic ? `: ${diagnostic}` : "";
        throw new Error(
          `GPU proof failed: ${proof.label} (status ${statusText})${diagnosticSuffix}`,
        );
      }
      // Optional proof failure is non-fatal but is no longer swallowed: a
      // CUDA-usability proof that reached the driver and failed marks the GPU
      // as proven-unusable so `status` can report it instead of "enabled"
      // (#4231, Jetson /dev/nvmap permission failures).
      if (proof.id === CUDA_USABILITY_PROOF_ID && cudaInitRan) {
        cudaFailure = { label: proof.label, detail: diagnostic };
      }
      console.warn(`  ⚠ GPU proof inconclusive: ${proof.label}`);
      if (diagnostic) console.warn(`    ${diagnostic}`);
    }
    const status: SandboxGpuProofResult["status"] = cudaVerified
      ? "verified"
      : cudaFailure
        ? "failed"
        : "unverified";
    if (status === "verified") {
      console.log("  ✓ Sandbox CUDA usability proven (cuInit succeeded).");
    } else if (status === "failed") {
      console.warn(`  ⚠ Sandbox CUDA proof failed: ${cudaFailure?.label}`);
      const lines =
        resolvedPlatform === "jetson"
          ? jetsonGpuProofRemediationLines()
          : sandboxGpuRemediationLines({
              wslDockerDesktopStatus: detectWslDockerDesktopStatus(deps),
            });
      for (const line of lines) console.warn(`    ${line}`);
    } else {
      console.warn("  ⚠ Sandbox GPU enabled but CUDA usability is unverified (no CUDA proof ran).");
    }
    return {
      status,
      cudaVerified,
      label: cudaFailure?.label ?? null,
      detail: cudaFailure?.detail ?? null,
      at: new Date().toISOString(),
    };
  };
}

export function validateSandboxGpuPreflight(
  config: SandboxGpuConfig,
  deps: SandboxGpuPreflightDeps = {},
): void {
  exitOnSandboxGpuConfigErrors(config);
  if (!config.sandboxGpuEnabled) return;
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return;

  if (config.hostGpuPlatform === "jetson") {
    validateJetsonSandboxGpuPreflight(deps);
    return;
  }

  const wslDockerDesktopStatus = detectWslDockerDesktopStatus(deps);
  if (wslDockerDesktopStatus === "docker-desktop") {
    console.log(
      "  Docker Desktop WSL detected; using Docker --gpus compatibility path instead of CDI spec validation.",
    );
    return;
  }

  const cdiSpecDirs = (deps.getDockerCdiSpecDirs ?? getDockerCdiSpecDirs)();
  const cdiSpecFiles = (deps.findReadableNvidiaCdiSpecFiles ?? findReadableNvidiaCdiSpecFiles)(
    cdiSpecDirs,
  );
  if (cdiSpecFiles.length === 0) {
    console.error("");
    console.error("  ✗ Docker CDI GPU support was not detected.");
    for (const line of sandboxGpuRemediationLines({
      wslDockerDesktopStatus,
    })) {
      console.error(`    ${line}`);
    }
    process.exit(1);
  }
  console.log(`  ✓ Docker CDI GPU support detected (${cdiSpecFiles.join(", ")})`);
}
