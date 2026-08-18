// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuMode,
} from "../../../src/lib/onboard/docker-gpu-patch.ts";
import {
  createLegacyKeepaliveFixture,
  type LegacyKeepaliveFixtureDeps,
  rewriteManagedInspectForLegacyKeepalive,
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

function managedImageInspect(
  entrypoint: string[] = ["/usr/local/bin/nemoclaw-start"],
  containerId = OLD_CONTAINER_ID,
  command: string[] = ["/bin/bash"],
): string {
  return JSON.stringify([
    {
      Id: containerId,
      Image: `sha256:${"c".repeat(64)}`,
      Name: "/openshell-e2e-2701",
      Config: {
        Image: "nemoclaw-managed:test",
        Entrypoint: entrypoint,
        Cmd: command,
        Env: ["OPENSHELL_SANDBOX_COMMAND=env /usr/local/bin/nemoclaw-start"],
      },
      HostConfig: {},
    },
  ]);
}

describe("gateway guard legacy keepalive fixture", () => {
  it("recreates only the pinned sandbox container with the reviewed legacy supervisor contract (#9364)", () => {
    const dockerCapture = vi.fn(() => managedImageInspect());
    const recreate = vi.fn((_, deps: Parameters<LegacyKeepaliveFixtureDeps["recreate"]>[1]) => {
      const rewritten = JSON.parse(
        deps?.dockerCapture?.(["inspect", "--type", "container", OLD_CONTAINER_ID], {
          ignoreError: true,
        }) ?? "null",
      );
      expect(rewritten[0].Config).toMatchObject({
        Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
        Cmd: [],
      });
      return successfulResult();
    });

    const result = createLegacyKeepaliveFixture(
      {
        sandboxName: "e2e-2701",
        expectedContainerId: OLD_CONTAINER_ID,
      },
      { recreate, dockerCapture },
    );

    expect(result.newContainerId).toBe(NEW_CONTAINER_ID);
    expect(recreate).toHaveBeenCalledOnce();
    expect(recreate).toHaveBeenCalledWith(
      {
        sandboxName: "e2e-2701",
        expectedOldContainerId: OLD_CONTAINER_ID,
        openshellSandboxCommand: ["sleep", "infinity"],
        timeoutSecs: 180,
      },
      { dockerCapture: expect.any(Function) },
    );
  });

  it("rejects an unreviewed managed-image entrypoint before legacy recreation (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(
        managedImageInspect(["/unreviewed/supervisor"]),
        OLD_CONTAINER_ID,
      ),
    ).toThrow("requires the reviewed managed-image process contract");
  });

  it("rejects an unreviewed managed-image command before legacy recreation (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(
        managedImageInspect(["/usr/local/bin/nemoclaw-start"], OLD_CONTAINER_ID, ["/bin/sh"]),
        OLD_CONTAINER_ID,
      ),
    ).toThrow("requires the reviewed managed-image process contract");
  });

  it("rejects Docker inspect output for a different container before legacy recreation (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(
        managedImageInspect(["/usr/local/bin/nemoclaw-start"], NEW_CONTAINER_ID),
        OLD_CONTAINER_ID,
      ),
    ).toThrow("Docker inspect identity changed");
  });

  it("produces a clone contract accepted by production startup-command validation (#9364)", () => {
    const rewritten = JSON.parse(
      rewriteManagedInspectForLegacyKeepalive(managedImageInspect(), OLD_CONTAINER_ID),
    );
    const immutableImage = `sha256:${"c".repeat(64)}`;
    const args = buildDockerGpuCloneRunArgs(rewritten[0], buildDockerGpuMode("startup-command"), {
      image: immutableImage,
      openshellSandboxCommand: ["sleep", "infinity"],
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--entrypoint",
        "/opt/openshell/bin/openshell-sandbox",
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
      ]),
    );
    expect(args.slice(args.indexOf(immutableImage))).toEqual([immutableImage]);
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
