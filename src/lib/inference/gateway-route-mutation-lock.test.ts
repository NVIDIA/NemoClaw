// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withGatewayRouteMutationLock } from "./gateway-route-mutation-lock";

describe("gateway route mutation lock", () => {
  it("serializes separate operations for the same gateway", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-gateway-lock-"));
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reportFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      reportFirstEntered = resolve;
    });
    const events: string[] = [];
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    try {
      const first = withGatewayRouteMutationLock(
        "nemoclaw",
        async () => {
          events.push("first-enter");
          reportFirstEntered();
          await firstReleased;
          events.push("first-exit");
        },
        options,
      );
      await firstEntered;
      const second = withGatewayRouteMutationLock(
        "nemoclaw",
        () => {
          events.push("second-enter");
        },
        options,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["first-enter"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
    } finally {
      releaseFirst();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("allows operations for different gateways to overlap", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-gateway-lock-"));
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reportFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      reportFirstEntered = resolve;
    });
    const options = { stateDir, pollIntervalMs: 1, timeoutMs: 5_000 };
    try {
      const first = withGatewayRouteMutationLock(
        "nemoclaw",
        async () => {
          reportFirstEntered();
          await firstReleased;
        },
        options,
      );
      await firstEntered;
      await expect(
        withGatewayRouteMutationLock("nemoclaw-9090", () => "second", options),
      ).resolves.toBe("second");
      releaseFirst();
      await first;
    } finally {
      releaseFirst();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
