// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION = 1 as const;
export const WINDOWS_MXC_PROCESS_CONTAINER_MINIMUM_BUILD = 26100 as const;
export type WindowsMxcQualifiedNativeArchitecture = "x64" | "arm64";

export interface WindowsMxcHostFacts {
  readonly platform: NodeJS.Platform;
  readonly nativeArchitecture: string;
  readonly release: string;
}

export type WindowsMxcProcessContainerCandidateResult =
  | {
      readonly candidate: true;
      readonly contractVersion: typeof WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION;
      readonly platform: "win32";
      readonly nativeArchitecture: WindowsMxcQualifiedNativeArchitecture;
      readonly windowsBuild: number;
    }
  | {
      readonly candidate: false;
      readonly contractVersion: typeof WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION;
      readonly reason:
        | "non-windows-host"
        | "unqualified-architecture"
        | "unknown-windows-build"
        | "windows-build-below-candidate-floor";
      readonly detail: string;
    };

/**
 * Extract the Windows build from the Node.js `os.release()` form
 * `<major>.<minor>.<build>[.<revision>]`.
 */
export function parseWindowsBuild(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)(?:\.\d+)?$/.exec(release.trim());
  if (!match) return null;

  const build = Number(match[1]);
  return Number.isSafeInteger(build) ? build : null;
}

/**
 * Evaluate the inactive native Windows/MXC `process_container` candidate.
 *
 * This is a host-facts contract only. A positive result does not select a
 * runtime provider or establish a supported Windows compatibility matrix.
 */
export function assessWindowsMxcProcessContainerCandidate(
  facts: WindowsMxcHostFacts,
  qualifiedNativeArchitecture: WindowsMxcQualifiedNativeArchitecture = "x64",
): WindowsMxcProcessContainerCandidateResult {
  if (facts.platform !== "win32") {
    return {
      candidate: false,
      contractVersion: WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION,
      reason: "non-windows-host",
      detail: "Native Windows/MXC requires a Windows host; WSL is not a native Windows host.",
    };
  }

  // `process.arch` identifies the Node.js binary and can report x64 under
  // Windows ARM64 emulation. The caller must supply the native host value.
  if (facts.nativeArchitecture !== qualifiedNativeArchitecture) {
    return {
      candidate: false,
      contractVersion: WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION,
      reason: "unqualified-architecture",
      detail: `The inactive Windows/MXC process_container candidate requires native ${qualifiedNativeArchitecture}.`,
    };
  }

  const windowsBuild = parseWindowsBuild(facts.release);
  if (windowsBuild === null) {
    return {
      candidate: false,
      contractVersion: WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION,
      reason: "unknown-windows-build",
      detail: "The Windows build could not be determined from the host release.",
    };
  }

  if (windowsBuild < WINDOWS_MXC_PROCESS_CONTAINER_MINIMUM_BUILD) {
    return {
      candidate: false,
      contractVersion: WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION,
      reason: "windows-build-below-candidate-floor",
      detail: `The Windows/MXC process_container candidate requires Windows build ${WINDOWS_MXC_PROCESS_CONTAINER_MINIMUM_BUILD} or newer.`,
    };
  }

  return {
    candidate: true,
    contractVersion: WINDOWS_MXC_PROCESS_CONTAINER_HOST_CONTRACT_VERSION,
    platform: "win32",
    nativeArchitecture: qualifiedNativeArchitecture,
    windowsBuild,
  };
}
