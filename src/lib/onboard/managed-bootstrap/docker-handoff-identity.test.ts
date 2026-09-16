// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createDockerManagedBootstrapAdapter } from "./docker";
import { authority, durablePreparation, fixture, NEW_ID, OLD_ID } from "./docker-test-fixture";

describe("Docker managed-bootstrap handoff identity", () => {
  it.each([
    { phase: "bootstrap-complete", identity: "sandbox-rebound", state: "Ready" },
    { phase: "bootstrap-complete", identity: "sandbox-alpha", state: "Stopped" },
    { phase: "shared-state-committed", identity: "sandbox-rebound", state: "Ready" },
    { phase: "shared-state-committed", identity: "sandbox-alpha", state: "Stopped" },
  ])(
    "retains transaction state when reconnect changes sandbox authority to $identity/$state during $phase",
    async ({ phase, identity, state }) => {
      const fake = fixture({ sharedState: "pending" });
      let authorityChanged = false;
      fake.deps.commandExecutor = {
        runBuffered: vi.fn(async () => {
          authorityChanged = authorityChanged || fake.journal?.phase === phase;
          return {
            outcome: { kind: "completed" as const, exitCode: 0 },
            stdout: "",
            stderr: "",
          };
        }),
      };
      fake.deps.runCaptureOpenshell = vi.fn((args) =>
        args[1] === "list"
          ? `alpha ${authorityChanged ? state : "Ready"}\n`
          : `Name: alpha\nID: ${authorityChanged ? identity : "sandbox-alpha"}\n`,
      );
      const adapter = createDockerManagedBootstrapAdapter(fake.deps);
      const { handle, request, snapshot } = authority();
      const prepared = await adapter.prepareBootstrapReplacement({
        handle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      });
      const durable = durablePreparation(handle, snapshot, prepared);
      const replacement = await adapter.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      });
      const completion = adapter.awaitBootstrap({ handle, snapshot, replacement, timeoutSecs: 1 });
      const result =
        phase === "bootstrap-complete"
          ? completion
          : adapter.finalizeBootstrap({
              outcome: "commit",
              handle,
              snapshot,
              prepared,
              durablePreparation: durable,
              replacement,
              completion: await completion,
            });

      await expect(result).rejects.toThrow(/OpenShell sandbox identity changed/);
      expect(authorityChanged).toBe(true);
      expect(fake.journal?.phase).toBe(phase);
      expect(fake.sharedState).toBe(phase === "bootstrap-complete" ? "pending" : "committed");
      expect(fake.original).toMatchObject({ Id: OLD_ID, State: { Running: false } });
      expect(fake.replacement).toMatchObject({ Id: NEW_ID, State: { Running: true } });
      expect(fake.finalization).toBeNull();
      expect(fake.events).not.toContain(`rm:${OLD_ID}`);
      expect(fake.events).not.toContain("journal:removed");
    },
  );
});
