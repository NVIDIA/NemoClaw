// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createLegacyKeepaliveFixture,
  type LegacyKeepaliveFixtureDeps,
} from "../live/gateway-guard-legacy-keepalive-fixture.ts";

const OLD_CONTAINER_ID = "a".repeat(64);
const NEW_CONTAINER_ID = "b".repeat(64);
const FIXTURE_PATH = fileURLToPath(
  new URL("../live/gateway-guard-legacy-keepalive-fixture.ts", import.meta.url),
);

function successfulResult() {
  return {
    applied: true as const,
    oldContainerId: OLD_CONTAINER_ID,
    newContainerId: NEW_CONTAINER_ID,
    originalName: "openshell-e2e-2701",
    backupContainerName: "openshell-e2e-2701-nemoclaw-gpu-backup-1",
    mode: {
      kind: "startup-command" as const,
      label: "startup command",
      device: "",
      args: [],
    },
    backupRemoved: true,
  };
}

describe("gateway guard legacy keepalive fixture", () => {
  it("recreates only the pinned sandbox container with the legacy startup command", () => {
    const recreate = vi.fn(() => successfulResult());

    const result = createLegacyKeepaliveFixture(
      {
        sandboxName: "e2e-2701",
        expectedContainerId: OLD_CONTAINER_ID,
      },
      { recreate },
    );

    expect(result.newContainerId).toBe(NEW_CONTAINER_ID);
    expect(recreate).toHaveBeenCalledOnce();
    expect(recreate).toHaveBeenCalledWith({
      sandboxName: "e2e-2701",
      expectedOldContainerId: OLD_CONTAINER_ID,
      openshellSandboxCommand: ["sleep", "infinity"],
      timeoutSecs: 180,
    });
  });

  it.each([
    {
      name: "an unremoved backup",
      result: { ...successfulResult(), backupRemoved: false },
      error: "left the original container backup in place",
    },
    {
      name: "a replacement with the wrong mode",
      result: {
        ...successfulResult(),
        mode: { ...successfulResult().mode, kind: "cdi" as const },
      },
      error: "did not use startup-command mode",
    },
    {
      name: "an unchanged container identity",
      result: { ...successfulResult(), newContainerId: OLD_CONTAINER_ID },
      error: "did not replace the container",
    },
  ])("fails closed for $name", ({ result, error }) => {
    const recreate = vi.fn(() => result) as LegacyKeepaliveFixtureDeps["recreate"];

    expect(() =>
      createLegacyKeepaliveFixture(
        {
          sandboxName: "e2e-2701",
          expectedContainerId: OLD_CONTAINER_ID,
        },
        { recreate },
      ),
    ).toThrow(error);
  });

  it("rejects an abbreviated container ID before recreation", () => {
    const recreate = vi.fn(() => successfulResult());

    expect(() =>
      createLegacyKeepaliveFixture(
        {
          sandboxName: "e2e-2701",
          expectedContainerId: "abc123",
        },
        { recreate },
      ),
    ).toThrow("expected container ID must be a full Docker container ID");
    expect(recreate).not.toHaveBeenCalled();
  });

  it("loads the real recreation dependency through the standalone tsx entrypoint", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", FIXTURE_PATH, "fixture-import-probe", "f".repeat(64)],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Could not find OpenShell Docker container for sandbox 'fixture-import-probe'.",
    );
    expect(result.stderr).not.toContain("deps.recreate is not a function");
  });
});
