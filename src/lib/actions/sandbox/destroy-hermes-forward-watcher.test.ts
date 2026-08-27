// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HermesForwardWatcherHost } from "../../adapters/openshell/hermes-forward-watcher";
import {
  createWatcherHost,
  managedCommandLine,
  seedWatcherPidFile,
  stateDirFor,
  withTempHome,
} from "../../../../test/helpers/hermes-forward-watcher-test-fixture";
import { cleanupSandboxServices } from "./destroy";

const SANDBOX = "hermes";
const PORT = "8642";

function destroyCleanup(
  hermesForwardWatcherHost: HermesForwardWatcherHost,
  hermesForwardWatcherStateDir: string,
  sandboxConfirmedDestroyed = true,
): void {
  cleanupSandboxServices(
    SANDBOX,
    { stopHostServices: false, sandboxConfirmedDestroyed },
    {
      getSandbox: vi.fn(() => null),
      googlechatWebhookTunnelPidDir: (servicePidDir: string) =>
        path.join(servicePidDir, "googlechat"),
      hermesForwardWatcherHost,
      hermesForwardWatcherStateDir,
      rmSync: vi.fn(),
      runOpenshell: vi.fn(() => ({ status: 0 })),
      stopAll: vi.fn(),
      stopGooglechatWebhookTunnel: vi.fn(() => ""),
      unloadOllamaModels: vi.fn(),
    },
  );
}

describe("destroy reaps the sandbox's Hermes forward watcher (#10385)", () => {
  it("stops the owned watcher a destroyed sandbox would otherwise leave running", () => {
    withTempHome("destroy-reap", (home) => {
      const watcher = seedWatcherPidFile(home, 60643, SANDBOX, PORT);
      const { host, killed } = createWatcherHost(home, watcher, { pid: 60643 });

      destroyCleanup(host, stateDirFor(home));

      expect(killed).toContain(60643);
    });
  });

  it("never signals a foreign-owned process holding the watcher PID file", () => {
    withTempHome("destroy-foreign", (home) => {
      const watcher = seedWatcherPidFile(home, 70643, SANDBOX, PORT);
      const { host, killed } = createWatcherHost(home, watcher, {
        owner: "someone-else",
        pid: 70643,
      });

      destroyCleanup(host, stateDirFor(home));

      expect(killed).toHaveLength(0);
    });
  });

  it("never signals an unrelated command line reusing the watcher PID", () => {
    withTempHome("destroy-unrelated", (home) => {
      const watcher = seedWatcherPidFile(home, 71643, SANDBOX, PORT);
      const { host, killed } = createWatcherHost(home, watcher, {
        commandLine: `/bin/sh -c ${managedCommandLine(watcher)}`,
        pid: 71643,
      });

      destroyCleanup(host, stateDirFor(home));

      expect(killed).toHaveLength(0);
    });
  });

  it("never reaps a still-registered sandbox's watcher when the delete was not confirmed", () => {
    // A failed delete leaves the sandbox registered and still running; the
    // watcher this call would otherwise stop is that live sandbox's own
    // forward self-healing, not an orphan's (#10385).
    withTempHome("destroy-unconfirmed", (home) => {
      const watcher = seedWatcherPidFile(home, 72643, SANDBOX, PORT);
      const { host, killed } = createWatcherHost(home, watcher, { pid: 72643 });

      destroyCleanup(host, stateDirFor(home), false);

      expect(killed).toHaveLength(0);
    });
  });
});
