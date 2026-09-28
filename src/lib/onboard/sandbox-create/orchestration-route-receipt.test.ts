// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { retireCustomOpenClawRouteReceipt } from "../created-sandbox-finalization";
import { retireRoute } from "./orchestration";

describe("custom OpenClaw route receipt handoff", () => {
  it("retires after exact identity checks and disarms rollback last", async () => {
    const order: string[] = [];
    const registered = {
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
    };
    const runtime = {
      GATEWAY_NAME: "nemoclaw-18080",
      registry: { getSandbox: vi.fn(() => registered) },
      sandboxRecreateTransaction: {
        revalidateCreatedSandboxLifecycleRegistration: vi.fn(() => order.push("identity")),
      },
      getSandboxRecreateObservation: vi.fn(),
      getRequestedSandboxAgentName: vi.fn(() => "openclaw"),
      sandboxCommandExecutor: {
        runBuffered: vi.fn(async () => {
          order.push("retire");
          return {
            outcome: { kind: "completed" as const, exitCode: 0 },
            stdout: "",
            stderr: "",
          };
        }),
      },
      retireCustomOpenClawRouteReceipt,
      sandboxCancelRollback: { disarm: vi.fn(() => order.push("disarm")) },
    } as unknown as SandboxCreateOrchestrationRuntime;

    await retireRoute(runtime, { sandboxName: "custom-box", fromDockerfile: "/tmp/Dockerfile" }, {
      name: "openclaw",
    } as never);

    expect(order).toEqual(["identity", "retire", "identity", "disarm"]);
  });
});
