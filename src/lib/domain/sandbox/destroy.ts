// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseLiveSandboxEntries } from "../../runtime-recovery";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const TERMINAL_OPEN_SHELL_SANDBOX_PHASES = new Set(["Error", "Failed"]);

function stripAnsi(value = ""): string {
  return String(value).replace(ANSI_RE, "");
}

export type SpawnLikeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export type DestroyGatewayCleanupDecision = "cleanup" | "preserve" | "prompt";

export type DestroyGatewayCleanupOptions = {
  cleanupGateway?: boolean;
  yes?: boolean;
  force?: boolean;
};

export type DestroyGatewayCleanupContext = {
  nonInteractive: boolean;
  platform: NodeJS.Platform;
};

export type LiveSandboxListProbe = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => { status: number | null; output: string };

export type DockerCaptureProbe = (args: string[], opts?: Record<string, unknown>) => string;

export type LiveSandboxProbeDeps = {
  captureOpenshell: LiveSandboxListProbe;
  dockerCapture: DockerCaptureProbe;
  timeoutMs: number;
};

export function isMissingSandboxDeleteOutput(output = ""): boolean {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

/**
 * True when a `sandbox delete` failure is a gateway transport error (the
 * OpenShell gateway at 127.0.0.1:8080 is not listening) rather than a real
 * delete rejection. When the gateway process is down every gateway call gets a
 * connection-refused/transport error, which used to make `destroy` fatal with
 * no bypass (#6046).
 */
export function isGatewayUnreachableDeleteOutput(output = ""): boolean {
  return /connection refused|os error (?:61|111)|tcp connect error|error trying to connect|transport error|failed to connect to|connect(?:ion)? timed out|deadline has elapsed|connection reset/i.test(
    stripAnsi(output),
  );
}

export function getSandboxDeleteOutcome(deleteResult: SpawnLikeResult): {
  output: string;
  alreadyGone: boolean;
  gatewayUnreachable: boolean;
} {
  const output = `${deleteResult.stdout || ""}${deleteResult.stderr || ""}`.trim();
  const failed = deleteResult.status !== 0;
  const alreadyGone = failed && isMissingSandboxDeleteOutput(output);
  return {
    output,
    alreadyGone,
    gatewayUnreachable: failed && !alreadyGone && isGatewayUnreachableDeleteOutput(output),
  };
}

export function shouldStopHostServicesAfterDestroy(input: {
  deleteSucceededOrAlreadyGone: boolean;
  registeredSandboxCount: number;
  sandboxStillRegistered: boolean;
}): boolean {
  return (
    input.deleteSucceededOrAlreadyGone &&
    input.registeredSandboxCount === 1 &&
    input.sandboxStillRegistered
  );
}

export function shouldCleanupGatewayAfterDestroy(input: {
  deleteSucceededOrAlreadyGone: boolean;
  removedRegistryEntry: boolean;
  noRegisteredSandboxes: boolean;
  noLiveSandboxes: boolean;
}): boolean {
  return (
    input.deleteSucceededOrAlreadyGone &&
    input.removedRegistryEntry &&
    input.noRegisteredSandboxes &&
    input.noLiveSandboxes
  );
}

/**
 * Decide the non-UI gateway cleanup path for a final sandbox destroy.
 *
 * Linux preserves the shared gateway by default for reuse (#2166), while
 * unattended macOS destroys clean it up so the leaked host listener is released
 * (#4662). Track removal in #6652: drop the macOS default after OpenShell
 * releases the Docker-driver listener fix, NemoClaw raises its supported
 * OpenShell floor to that fixed version, and live macOS final destroys release
 * the listener without forced gateway cleanup.
 * Native win32 hosts keep the conservative non-macOS default because supported
 * Windows runs go through WSL2 and report `linux`.
 */
export function resolveDestroyGatewayCleanupDecision(
  options: DestroyGatewayCleanupOptions,
  context: DestroyGatewayCleanupContext,
): DestroyGatewayCleanupDecision {
  if (options.cleanupGateway === true) return "cleanup";
  if (options.cleanupGateway === false) return "preserve";
  if (options.yes === true || options.force === true || context.nonInteractive) {
    return context.platform === "darwin" ? "cleanup" : "preserve";
  }
  return "prompt";
}

function escapeDockerNameRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function hasRunningDockerSandboxContainer(
  sandboxName: string,
  dockerCapture: DockerCaptureProbe,
  timeoutMs: number,
): boolean {
  try {
    const output = dockerCapture(
      [
        "ps",
        "--filter",
        `name=^/openshell-${escapeDockerNameRegex(sandboxName)}-`,
        "--format",
        "{{.Names}}",
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: timeoutMs,
      },
    );
    return output.trim().length > 0;
  } catch {
    // Fail closed for the #4662 invalid-state boundary: OpenShell may report a
    // terminal sandbox row while the Docker sandbox container is still running.
    // Docker is the authoritative source for that live-container check, and the
    // OpenShell false terminal state cannot be fixed from this destroy path. If
    // the Docker probe itself fails, preserve the shared gateway so a live
    // sandbox does not lose its listener on final destroy. Covered by
    // destroy.test.ts; remove this fallback after OpenShell no longer emits
    // false terminal rows and #6652 is closed.
    return true;
  }
}

export function hasNoLiveSandboxes({
  captureOpenshell,
  dockerCapture,
  timeoutMs,
}: LiveSandboxProbeDeps): boolean {
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: timeoutMs,
  });
  if (liveList.status !== 0) {
    return false;
  }
  return parseLiveSandboxEntries(liveList.output).every((entry) => {
    if (!TERMINAL_OPEN_SHELL_SANDBOX_PHASES.has(entry.phase ?? "")) return false;
    return !hasRunningDockerSandboxContainer(entry.name, dockerCapture, timeoutMs);
  });
}
