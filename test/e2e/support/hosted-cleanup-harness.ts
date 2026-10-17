// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import type { cleanupBootstrapState } from "../live/hosted-e2e-cleanup.ts";

export function cleanupResult(
  stdout = "",
  extra: Partial<ShellProbeResult> = {},
): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    signal: null,
    artifacts: { stdout: "stdout", stderr: "stderr", result: "result" },
    ...extra,
  };
}

export function bootstrapCleanupHarness(
  failure = "none",
  availability = cleanupResult("/usr/local/bin/tool"),
) {
  const events: string[] = [];
  const command = vi.fn(async (executable: string) => {
    if (executable === "sh") return availability;
    const stage = executable === "nemoclaw" ? "destroy" : "clone";
    events.push(stage);
    return cleanupResult("", { exitCode: failure === stage ? 1 : 0 });
  });
  const cleanupSandbox = vi.fn(async () => {
    events.push("delete");
    if (failure === "delete") throw new Error("delete failed");
  });
  const cleanupGatewayRegistration = vi.fn(async () => {
    events.push("gateway");
    if (failure === "gateway") throw new Error("gateway failed");
  });

  const input: Parameters<typeof cleanupBootstrapState>[0] = {
    host: { command, cleanupGatewayRegistration } as unknown as HostCliClient,
    sandbox: {
      hasGatewayForInitialCleanup: async () => true,
      cleanupSandbox,
    } as unknown as SandboxClient,
    name: "target",
    cloneDir: "/tmp/task-owned-clone",
    env: {},
  };
  return { input, events };
}
