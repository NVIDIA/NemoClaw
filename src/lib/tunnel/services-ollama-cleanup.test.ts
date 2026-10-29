// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { stopAll } from "./services";

it("runs injected Ollama cleanup before reporting services stopped", () => {
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-stop-"));
  const cleanup = vi.fn();
  const clearPendingOllamaModelCleanup = vi.fn();
  const ollamaCleanupOwner = {
    name: "test-box",
    gatewayName: "nemoclaw-32677",
    gatewayPort: 32677,
    lifecycleGeneration: "generation-test-box",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    stopAll({
      pidDir,
      sandboxName: "test-box",
      ollamaCleanupOwner,
      unloadOllamaModels: cleanup,
      clearPendingOllamaModelCleanup,
      unmanagedCloudflaredPids: () => [],
    });
    const stoppedCallIndex = logSpy.mock.calls.findIndex(([message]) =>
      String(message).includes("All services stopped"),
    );
    const stoppedCallOrder = logSpy.mock.invocationCallOrder[stoppedCallIndex];
    expect(cleanup).toHaveBeenCalledOnce();
    expect(clearPendingOllamaModelCleanup).toHaveBeenCalledWith(ollamaCleanupOwner);
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(stoppedCallOrder ?? 0);
  } finally {
    logSpy.mockRestore();
    fs.rmSync(pidDir, { recursive: true, force: true });
  }
});
