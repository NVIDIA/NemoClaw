// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { addTraceEvent, withDashboardReadinessTrace, withSandboxReadinessTrace } from "./tracing";

type RunCaptureOpenshell = (
  args: string[],
  options?: { ignoreError?: boolean },
) => string;

export function waitForSandboxReadyWithTrace(options: {
  sandboxName: string;
  attempts: number;
  delaySeconds: number;
  runCaptureOpenshell: RunCaptureOpenshell;
  isSandboxReady: (output: string, sandboxName: string) => boolean;
  isLinuxDockerDriverGatewayEnabled: () => boolean;
  sleep: (seconds: number) => void;
}): boolean {
  const {
    sandboxName,
    attempts,
    delaySeconds,
    runCaptureOpenshell,
    isSandboxReady,
    isLinuxDockerDriverGatewayEnabled,
    sleep,
  } = options;
  return withSandboxReadinessTrace(sandboxName, { attempts, delay_seconds: delaySeconds }, () => {
    for (let i = 0; i < attempts; i += 1) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) {
        addTraceEvent("ready", { attempt: i + 1, source: "sandbox_list" });
        return true;
      }

      // Package-managed OpenShell gateways report readiness through
      // `sandbox list`; legacy Kubernetes gateways may still expose pod state.
      if (isLinuxDockerDriverGatewayEnabled()) {
        if (i < attempts - 1) sleep(delaySeconds);
        continue;
      }
      const podPhase = runCaptureOpenshell(
        [
          "doctor",
          "exec",
          "--",
          "kubectl",
          "-n",
          "openshell",
          "get",
          "pod",
          sandboxName,
          "-o",
          "jsonpath={.status.phase}",
        ],
        { ignoreError: true },
      );
      if (podPhase === "Running") {
        addTraceEvent("ready", { attempt: i + 1, source: "pod_phase" });
        return true;
      }
      if (i < attempts - 1) sleep(delaySeconds);
    }
    addTraceEvent("not_ready", { attempts });
    return false;
  });
}

export function waitForCreatedSandboxReadyWithTrace(options: {
  sandboxName: string;
  timeoutSecs: number;
  runCaptureOpenshell: RunCaptureOpenshell;
  isSandboxReady: (output: string, sandboxName: string) => boolean;
  sleep: (seconds: number) => void;
}): boolean {
  const { sandboxName, timeoutSecs, runCaptureOpenshell, isSandboxReady, sleep } = options;
  return withSandboxReadinessTrace(sandboxName, { timeout_seconds: timeoutSecs }, () => {
    const readyAttempts = Math.max(1, Math.ceil(timeoutSecs / 2));
    for (let i = 0; i < readyAttempts; i++) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) {
        addTraceEvent("ready", { attempt: i + 1 });
        return true;
      }
      if (i < readyAttempts - 1) sleep(2);
    }
    addTraceEvent("not_ready", { attempts: readyAttempts });
    return false;
  });
}

export function waitForDashboardReadyWithTrace(options: {
  sandboxName: string;
  port: string | number;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleep: (seconds: number) => void;
}): void {
  const { sandboxName, port, runCaptureOpenshell, sleep } = options;
  withDashboardReadinessTrace(sandboxName, port, 15, () => {
    for (let i = 0; i < 15; i++) {
      const readyOutput = runCaptureOpenshell(
        [
          "sandbox",
          "exec",
          "-n",
          sandboxName,
          "--",
          "curl",
          "-so",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "3",
          `http://localhost:${port}/health`,
        ],
        { ignoreError: true },
      );
      const readyCode = parseInt((readyOutput || "").trim(), 10) || 0;
      addTraceEvent("dashboard_probe", { attempt: i + 1, http_status: readyCode });
      if (readyCode === 200 || readyCode === 401) {
        console.log("  ✓ Dashboard is live");
        return;
      }
      if (i === 14) {
        console.warn("  Dashboard taking longer than expected to start. Continuing...");
      } else {
        sleep(2);
      }
    }
  });
}
