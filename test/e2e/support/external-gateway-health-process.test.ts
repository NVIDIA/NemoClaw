// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { stopExternalGatewayHealthGateway } from "../fixtures/external-gateway-health-process.ts";

type FakeGateway = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ChildProcess["kill"];
};

function gatewayWithForcedKill(onForcedKill: (gateway: FakeGateway) => void): {
  gateway: ChildProcess;
  kill: ReturnType<typeof vi.fn<ChildProcess["kill"]>>;
} {
  const gateway = new EventEmitter() as FakeGateway;
  gateway.exitCode = null;
  gateway.signalCode = null;
  const kill = vi.fn<ChildProcess["kill"]>();
  kill.mockReturnValueOnce(true);
  kill.mockImplementationOnce(() => {
    onForcedKill(gateway);
    return true;
  });
  gateway.kill = kill;
  return { gateway: gateway as ChildProcess, kill };
}

describe("external gateway health process cleanup", () => {
  it("waits for forced gateway exit before cleanup completes (#9872)", async () => {
    vi.useFakeTimers();
    try {
      const { gateway, kill } = gatewayWithForcedKill((fakeGateway) => {
        setTimeout(() => {
          fakeGateway.signalCode = "SIGKILL";
          fakeGateway.emit("exit", null, "SIGKILL");
        }, 50);
      });
      let completed = false;
      const cleanup = stopExternalGatewayHealthGateway(gateway).then(() => {
        completed = true;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(completed).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      await cleanup;
      expect(completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a gateway that remains active after forced cleanup (#9872)", async () => {
    vi.useFakeTimers();
    try {
      const { gateway } = gatewayWithForcedKill(() => undefined);
      const cleanup = expect(stopExternalGatewayHealthGateway(gateway)).rejects.toThrow(
        "external gateway health gateway did not stop after SIGKILL",
      );

      await vi.advanceTimersByTimeAsync(4_000);
      await cleanup;
    } finally {
      vi.useRealTimers();
    }
  });
});
