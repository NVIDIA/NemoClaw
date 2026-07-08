// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type SandboxCommandExecutor = (
  name: string,
  script: string,
) => { status: number; stdout: string; stderr: string } | null;

export type OpenClawRuntimeFailureKind =
  | "normal_runtime"
  | "base_only_image"
  | "sandbox_unreachable"
  | "inconclusive";

export interface OpenClawRuntimeFailureDiagnosis {
  kind: OpenClawRuntimeFailureKind;
  gatewayLogPresent: boolean | null;
  startupScriptPresent: boolean | null;
  configPresent: boolean | null;
}

export interface CustomOpenClawRuntimeFailureHints {
  gateway: string;
  dashboard: string;
}

const OPENCLAW_RUNTIME_PROBE =
  "printf 'nemoclaw-runtime-probe-v1 '; " +
  "if [ -e /tmp/gateway.log ]; then printf 'log=1 '; else printf 'log=0 '; fi; " +
  "if [ -x /usr/local/bin/nemoclaw-start ]; then printf 'start=1 '; else printf 'start=0 '; fi; " +
  "if [ -e /sandbox/.openclaw/openclaw.json ]; then printf 'config=1\\n'; else printf 'config=0\\n'; fi";

/**
 * This diagnostic handles an invalid state authored at the custom-image source
 * boundary: a user Dockerfile passed to `onboard --from` selects the
 * intermediate `sandbox-base` image as its final runtime. Preventing that state
 * earlier would require reliable static analysis of arbitrary multi-stage
 * Dockerfiles or a new build-time image contract. The focused classifier tests
 * prevent false positives, and the live custom-plugin E2E proves the supported
 * full-runtime path.
 * REMOVE-WHEN: #5998 supplies the managed plugin lifecycle, or a build-time
 * image contract validator replaces this runtime fallback.
 */

export function shouldDiagnoseCustomOpenClawRuntime(
  fromDockerfile: string | null | undefined,
  selectedAgentName: string | null | undefined,
): boolean {
  return Boolean(fromDockerfile && selectedAgentName === "openclaw");
}

/**
 * Distinguish the documented sandbox-base-only failure from an ordinary
 * gateway startup failure without reading config or log contents.
 */
export function classifyOpenClawRuntimeFailure(
  sandboxName: string,
  executeSandboxCommand: SandboxCommandExecutor,
): OpenClawRuntimeFailureDiagnosis {
  const result = executeSandboxCommand(sandboxName, OPENCLAW_RUNTIME_PROBE);
  if (!result) {
    return {
      kind: "sandbox_unreachable",
      gatewayLogPresent: null,
      startupScriptPresent: null,
      configPresent: null,
    };
  }

  const match = result.stdout.match(
    /(?:^|\n)[ ]*(?:(?:\[stdout\]|stdout:)[ ]*)?nemoclaw-runtime-probe-v1 log=([01]) start=([01]) config=([01])(?:\r?\n|$)/,
  );
  if (result.status !== 0 || !match) {
    return {
      kind: "inconclusive",
      gatewayLogPresent: null,
      startupScriptPresent: null,
      configPresent: null,
    };
  }

  const gatewayLogPresent = match[1] === "1";
  const startupScriptPresent = match[2] === "1";
  const configPresent = match[3] === "1";
  let kind: OpenClawRuntimeFailureKind = "inconclusive";
  if (!gatewayLogPresent && !startupScriptPresent && !configPresent) {
    kind = "base_only_image";
  } else if (startupScriptPresent && configPresent) {
    kind = "normal_runtime";
  }
  return { kind, gatewayLogPresent, startupScriptPresent, configPresent };
}

export function buildCustomOpenClawRuntimeFailureHints(
  diagnosis: OpenClawRuntimeFailureDiagnosis,
): CustomOpenClawRuntimeFailureHints | null {
  if (diagnosis.kind !== "base_only_image") return null;
  return {
    gateway:
      "This custom image does not contain the NemoClaw-managed OpenClaw runtime: " +
      "`/usr/local/bin/nemoclaw-start` and `/sandbox/.openclaw/openclaw.json` are missing, " +
      "and `/tmp/gateway.log` was never created. `nemoclaw onboard --from` uses the supplied " +
      "Dockerfile as the complete sandbox image; it does not layer it over the managed runtime. " +
      "Build from the full NemoClaw Dockerfile and context for the same release instead of using " +
      "`ghcr.io/nvidia/nemoclaw/sandbox-base` directly.",
    dashboard:
      "The dashboard cannot start until the custom image includes the NemoClaw-managed OpenClaw runtime.",
  };
}
