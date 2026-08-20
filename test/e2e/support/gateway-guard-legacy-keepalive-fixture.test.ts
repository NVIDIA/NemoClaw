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
const MANAGED_RUNTIME_STARTUP_COMMAND =
  "env CHAT_UI_URL=http://127.0.0.1:18789 NEMOCLAW_DASHBOARD_PORT=18789 NEMOCLAW_SANDBOX_NAME=e2e-2701 /usr/local/bin/nemoclaw-start";
const MANAGED_RUNTIME_COMMAND_ENV = `OPENSHELL_SANDBOX_COMMAND=${MANAGED_RUNTIME_STARTUP_COMMAND}`;
const OPEN_SHELL_IDENTITY_ENV = [
  "OPENSHELL_OCI_IMAGE_USER=sandbox",
  "OPENSHELL_SANDBOX_UID=",
  "OPENSHELL_SANDBOX_GID=",
] as const;
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

function managedRuntimeInspect({
  entrypoint = ["/opt/openshell/bin/openshell-sandbox"],
  command = ["--workdir", "/sandbox"],
  environment = [MANAGED_RUNTIME_COMMAND_ENV, ...OPEN_SHELL_IDENTITY_ENV],
}: {
  entrypoint?: string[];
  command?: string[] | null;
  environment?: unknown;
} = {}): string {
  return JSON.stringify([
    {
      Id: OLD_CONTAINER_ID,
      Image: `sha256:${"c".repeat(64)}`,
      Name: "/openshell-e2e-2701",
      Config: {
        Image: "nemoclaw-managed:test",
        User: "0",
        WorkingDir: "/",
        Entrypoint: entrypoint,
        Cmd: command,
        Env: environment,
        Labels: { "openshell.ai/managed-by": "openshell" },
      },
      HostConfig: {},
    },
  ]);
}

function managedRuntimeInspectWithoutOciImageUser(
  mutate?: (record: {
    Config: {
      User?: string;
      WorkingDir?: string;
      Labels?: Record<string, string>;
    };
  }) => void,
): string {
  const records = JSON.parse(
    managedRuntimeInspect({
      environment: [
        MANAGED_RUNTIME_COMMAND_ENV,
        "OPENSHELL_SANDBOX_UID=",
        "OPENSHELL_SANDBOX_GID=",
      ],
    }),
  ) as Array<{
    Config: {
      User?: string;
      WorkingDir?: string;
      Labels?: Record<string, string>;
    };
  }>;
  const record = records[0]!;
  mutate?.(record);
  return JSON.stringify(records);
}

describe("gateway guard legacy keepalive fixture", () => {
  it("recreates only the pinned sandbox container with the reviewed supervisor and legacy workload (#9364)", () => {
    const dockerCapture = vi.fn(() => managedRuntimeInspect());
    const recreate = vi.fn((_, deps: Parameters<LegacyKeepaliveFixtureDeps["recreate"]>[1]) => {
      const rewritten = JSON.parse(
        deps?.dockerCapture?.(["inspect", "--type", "container", OLD_CONTAINER_ID], {
          ignoreError: true,
        }) ?? "null",
      );
      expect(rewritten[0].Config).toMatchObject({
        Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
        Cmd: ["--workdir", "/sandbox"],
        Env: [MANAGED_RUNTIME_COMMAND_ENV, "OPENSHELL_SANDBOX_UID=", "OPENSHELL_SANDBOX_GID="],
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

  it("accepts the inspected OpenShell-managed runtime process contract before legacy recreation (#9364)", () => {
    const rewritten = JSON.parse(
      rewriteManagedInspectForLegacyKeepalive(managedRuntimeInspect(), OLD_CONTAINER_ID),
    );

    expect(rewritten[0].Config).toMatchObject({
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: ["--workdir", "/sandbox"],
      Env: [MANAGED_RUNTIME_COMMAND_ENV, "OPENSHELL_SANDBOX_UID=", "OPENSHELL_SANDBOX_GID="],
    });
  });

  it("removes only the post-legacy OCI workspace marker before keepalive recreation (#9364)", () => {
    const inspect = JSON.parse(managedRuntimeInspect());
    inspect[0].Config.Env.push("OPENSHELL_OCI_IMAGE_USER_NOTE=preserved");

    const rewritten = JSON.parse(
      rewriteManagedInspectForLegacyKeepalive(JSON.stringify(inspect), OLD_CONTAINER_ID),
    );

    expect(rewritten[0].Config.Env).not.toContain("OPENSHELL_OCI_IMAGE_USER=sandbox");
    expect(rewritten[0].Config.Env).toEqual(
      expect.arrayContaining([
        MANAGED_RUNTIME_COMMAND_ENV,
        "OPENSHELL_SANDBOX_UID=",
        "OPENSHELL_SANDBOX_GID=",
        "OPENSHELL_OCI_IMAGE_USER_NOTE=preserved",
      ]),
    );
  });

  it("rejects the OCI marker outside the reviewed root-supervisor workspace boundary (#9364)", () => {
    const inspect = JSON.parse(managedRuntimeInspect());
    inspect[0].Config.WorkingDir = "/sandbox";

    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(JSON.stringify(inspect), OLD_CONTAINER_ID),
    ).toThrow("requires the reviewed OpenShell OCI workspace identity contract");
  });

  it("accepts the reviewed prior-recreation identity metadata without the OCI-user marker (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(
        managedRuntimeInspectWithoutOciImageUser(),
        OLD_CONTAINER_ID,
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: "UID-only identity metadata",
      inspect: managedRuntimeInspect({
        environment: [MANAGED_RUNTIME_COMMAND_ENV, "OPENSHELL_SANDBOX_UID="],
      }),
    },
    {
      name: "GID-only identity metadata",
      inspect: managedRuntimeInspect({
        environment: [MANAGED_RUNTIME_COMMAND_ENV, "OPENSHELL_SANDBOX_GID="],
      }),
    },
    {
      name: "a non-root user without the OCI-user marker",
      inspect: managedRuntimeInspectWithoutOciImageUser((record) => {
        record.Config.User = "1000";
      }),
    },
    {
      name: "a non-root working directory without the OCI-user marker",
      inspect: managedRuntimeInspectWithoutOciImageUser((record) => {
        record.Config.WorkingDir = "/sandbox";
      }),
    },
  ])("rejects $name before legacy recreation (#9364)", ({ inspect }) => {
    expect(() => rewriteManagedInspectForLegacyKeepalive(inspect, OLD_CONTAINER_ID)).toThrow(
      "requires the reviewed OpenShell OCI workspace identity contract",
    );
  });

  it.each([
    {
      name: "a missing OpenShell management label",
      inspect: managedRuntimeInspectWithoutOciImageUser((record) => {
        delete record.Config.Labels;
      }),
    },
    {
      name: "a changed OpenShell management label",
      inspect: managedRuntimeInspectWithoutOciImageUser((record) => {
        record.Config.Labels = { "openshell.ai/managed-by": "unreviewed" };
      }),
    },
  ])("rejects $name before legacy recreation (#9364)", ({ inspect }) => {
    expect(() => rewriteManagedInspectForLegacyKeepalive(inspect, OLD_CONTAINER_ID)).toThrow(
      "requires the reviewed managed-image or OpenShell-managed runtime process contract",
    );
  });

  it("accepts the reviewed empty OpenShell supervisor command before legacy recreation (#9364)", () => {
    const rewritten = JSON.parse(
      rewriteManagedInspectForLegacyKeepalive(
        managedRuntimeInspect({ command: [] }),
        OLD_CONTAINER_ID,
      ),
    );

    expect(rewritten[0].Config.Cmd).toEqual(["--workdir", "/sandbox"]);
  });

  it("accepts the reviewed nullable empty OpenShell supervisor command before legacy recreation (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(
        managedRuntimeInspect({ command: null }),
        OLD_CONTAINER_ID,
      ),
    ).not.toThrow();
  });

  it("accepts an omitted empty OpenShell supervisor command before legacy recreation (#9364)", () => {
    const inspect = JSON.parse(managedRuntimeInspect());
    delete inspect[0].Config.Cmd;

    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(JSON.stringify(inspect), OLD_CONTAINER_ID),
    ).not.toThrow();
  });

  it("retains the reviewed raw managed-image process contract before legacy recreation (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(managedImageInspect(), OLD_CONTAINER_ID),
    ).not.toThrow();
  });

  it.each([
    {
      name: "a missing managed startup command",
      environment: [],
    },
    {
      name: "an arbitrary startup workload",
      environment: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"],
    },
  ])("rejects a raw managed-image source with $name (#9364)", ({ environment }) => {
    const inspect = JSON.parse(managedImageInspect());
    inspect[0].Config.Env = environment;

    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(JSON.stringify(inspect), OLD_CONTAINER_ID),
    ).toThrow("requires the reviewed managed startup workload");
  });

  it.each([
    {
      name: "a missing managed startup command",
      inspect: managedRuntimeInspect({ environment: [] }),
    },
    {
      name: "a non-array managed runtime environment",
      inspect: managedRuntimeInspect({ environment: {} }),
    },
    {
      name: "a non-string managed runtime environment entry",
      inspect: managedRuntimeInspect({ environment: [MANAGED_RUNTIME_COMMAND_ENV, 42] }),
    },
    {
      name: "duplicate managed startup commands",
      inspect: managedRuntimeInspect({
        environment: [MANAGED_RUNTIME_COMMAND_ENV, MANAGED_RUNTIME_COMMAND_ENV],
      }),
    },
    {
      name: "a conflicting malformed startup command entry",
      inspect: managedRuntimeInspect({
        environment: [MANAGED_RUNTIME_COMMAND_ENV, "OPENSHELL_SANDBOX_COMMAND"],
      }),
    },
    {
      name: "an arbitrary startup workload",
      inspect: managedRuntimeInspect({
        environment: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"],
      }),
    },
    {
      name: "a shell-shaped startup assignment",
      inspect: managedRuntimeInspect({
        environment: ["OPENSHELL_SANDBOX_COMMAND=env VALUE=$(id) /usr/local/bin/nemoclaw-start"],
      }),
    },
    {
      name: "a non-assignment startup prefix",
      inspect: managedRuntimeInspect({
        environment: ["OPENSHELL_SANDBOX_COMMAND=env bash /usr/local/bin/nemoclaw-start"],
      }),
    },
    {
      name: "a process-injection startup assignment",
      inspect: managedRuntimeInspect({
        environment: [
          "OPENSHELL_SANDBOX_COMMAND=env NODE_OPTIONS=--require=/tmp/payload.cjs /usr/local/bin/nemoclaw-start",
        ],
      }),
    },
    {
      name: "duplicate startup assignment names",
      inspect: managedRuntimeInspect({
        environment: [
          "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:18789 CHAT_UI_URL=http://127.0.0.1:18790 /usr/local/bin/nemoclaw-start",
        ],
      }),
    },
  ])("rejects $name before legacy recreation (#9364)", ({ inspect }) => {
    expect(() => rewriteManagedInspectForLegacyKeepalive(inspect, OLD_CONTAINER_ID)).toThrow(
      "requires the reviewed managed-image or OpenShell-managed runtime process contract",
    );
  });

  it("canonicalizes the OpenShell-managed source independently of its inherited image process tuple (#9364)", () => {
    const rewritten = JSON.parse(
      rewriteManagedInspectForLegacyKeepalive(
        managedRuntimeInspect({
          entrypoint: ["/image/entrypoint"],
          command: ["/image/command"],
        }),
        OLD_CONTAINER_ID,
      ),
    );

    expect(rewritten[0].Config).toMatchObject({
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: ["--workdir", "/sandbox"],
    });
  });

  it("rejects an unreviewed managed-image entrypoint before legacy recreation (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(
        managedImageInspect(["/unreviewed/supervisor"]),
        OLD_CONTAINER_ID,
      ),
    ).toThrow("requires the reviewed managed-image or OpenShell-managed runtime process contract");
  });

  it("rejects an unreviewed managed-image command before legacy recreation (#9364)", () => {
    expect(() =>
      rewriteManagedInspectForLegacyKeepalive(
        managedImageInspect(["/usr/local/bin/nemoclaw-start"], OLD_CONTAINER_ID, ["/bin/sh"]),
        OLD_CONTAINER_ID,
      ),
    ).toThrow("requires the reviewed managed-image or OpenShell-managed runtime process contract");
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
    expect(args).not.toContain("OPENSHELL_OCI_IMAGE_USER=sandbox");
    expect(args.slice(args.indexOf(immutableImage))).toEqual([
      immutableImage,
      "--workdir",
      "/sandbox",
    ]);
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
