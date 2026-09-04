// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { MANAGED_BOOTSTRAP_IDENTITY_ENV } from "./adapter";
import {
  inspectExactPodmanHeldWorkload,
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "./podman-held-workload";

const RUNTIME_ID = "1".repeat(64);
const IMAGE_ID = "2".repeat(64);
const OTHER_IMAGE_ID = "3".repeat(64);
const BOOTSTRAP_IDENTITY = "4".repeat(64);
const SANDBOX_ID = "sandbox-uuid-1";
const SANDBOX_NAME = "demo-box";
const SANDBOX_NAMESPACE = PODMAN_SANDBOX_NAMESPACE;
const SUPERVISOR_ARGV = ["/opt/openshell/bin/supervisor", "--config", "/etc/openshell.toml"];
const HELD_WORKLOAD_ARGV = [
  "/usr/local/bin/nemoclaw-managed-hold",
  "--bootstrap-identity",
  BOOTSTRAP_IDENTITY,
  "/usr/local/bin/nemoclaw-start",
];

function result(stdout: string, overrides: Partial<ContainerEngineCommandResult> = {}) {
  return { status: 0, stdout, stderr: "", ...overrides };
}

function listOutput(ids: readonly string[] = [RUNTIME_ID]): string {
  return JSON.stringify(ids.map((Id) => ({ Id })));
}

function inspectOutput(
  overrides: {
    readonly bootstrapIdentity?: string;
    readonly id?: string;
    readonly image?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly name?: string;
    readonly running?: boolean;
    readonly sandboxId?: string;
    readonly sandboxName?: string;
    readonly user?: string;
  } = {},
): string {
  const sandboxId = overrides.sandboxId ?? SANDBOX_ID;
  const sandboxName = overrides.sandboxName ?? SANDBOX_NAME;
  return JSON.stringify([
    {
      Id: overrides.id ?? RUNTIME_ID,
      Image: overrides.image ?? `sha256:${IMAGE_ID}`,
      Name: overrides.name ?? `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`,
      Config: {
        Cmd: SUPERVISOR_ARGV.slice(1),
        Entrypoint: [SUPERVISOR_ARGV[0]],
        Env: [
          `${MANAGED_BOOTSTRAP_IDENTITY_ENV}=${overrides.bootstrapIdentity ?? BOOTSTRAP_IDENTITY}`,
          "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
          "OPENSHELL_SANDBOX_TOKEN_FILE=/run/secrets/openshell-token",
        ],
        Labels: overrides.labels ?? {
          [PODMAN_MANAGED_LABEL]: "true",
          [PODMAN_SANDBOX_ID_LABEL]: sandboxId,
          [PODMAN_SANDBOX_NAME_LABEL]: sandboxName,
          [PODMAN_SANDBOX_NAMESPACE_LABEL]: SANDBOX_NAMESPACE,
          [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
        },
        User: overrides.user ?? "root",
      },
      State: { Paused: false, Restarting: false, Running: overrides.running ?? true },
    },
  ]);
}

function engineWith(
  outputs: readonly ContainerEngineCommandResult[],
  overrides: Partial<ContainerEngine> = {},
) {
  const queue = [...outputs];
  const capture = vi.fn(() => queue.shift() as ContainerEngineCommandResult);
  const engine: ContainerEngine = {
    operation: "managed-bootstrap",
    authorityId: "test:podman-socket",
    engineId: "podman",
    displayName: "Podman",
    capture,
    captureHost: vi.fn(),
    ...overrides,
  };
  return { capture, engine };
}

function inspect(
  engine: ContainerEngine,
  sandboxNamespace = SANDBOX_NAMESPACE,
  identity: { readonly sandboxId?: string; readonly sandboxName?: string } = {},
) {
  return inspectExactPodmanHeldWorkload({
    bootstrapIdentity: BOOTSTRAP_IDENTITY,
    engine,
    expectedHeldWorkloadArgv: HELD_WORKLOAD_ARGV,
    expectedImageContentId: `sha256:${IMAGE_ID}`,
    expectedSupervisorArgv: SUPERVISOR_ARGV,
    sandboxId: identity.sandboxId ?? SANDBOX_ID,
    sandboxName: identity.sandboxName ?? SANDBOX_NAME,
    sandboxNamespace,
  });
}

describe("Podman managed bootstrap held-workload inspection", () => {
  it("pins one exact running OpenShell workload across two inspections", () => {
    const fake = engineWith([
      result(listOutput()),
      result(inspectOutput()),
      result(inspectOutput()),
    ]);

    expect(inspect(fake.engine)).toEqual({
      containerName: `openshell-${PODMAN_SANDBOX_WORKSPACE}--${SANDBOX_NAME}-${SANDBOX_ID}`,
      heldWorkloadArgv: HELD_WORKLOAD_ARGV,
      imageContentId: `sha256:${IMAGE_ID}`,
      labels: {
        [PODMAN_MANAGED_LABEL]: "true",
        [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
        [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
        [PODMAN_SANDBOX_NAMESPACE_LABEL]: SANDBOX_NAMESPACE,
        [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
      },
      runtimeId: RUNTIME_ID,
      running: true,
      sandboxId: SANDBOX_ID,
      sandboxName: SANDBOX_NAME,
      supervisorArgv: SUPERVISOR_ARGV,
    });
    expect(fake.capture.mock.calls).toEqual([
      [
        [
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `label=${PODMAN_MANAGED_LABEL}=true`,
          "--filter",
          `label=${PODMAN_SANDBOX_ID_LABEL}=${SANDBOX_ID}`,
          "--filter",
          `label=${PODMAN_SANDBOX_NAME_LABEL}=${SANDBOX_NAME}`,
          "--filter",
          `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
          "--format",
          "json",
        ],
      ],
      [["container", "inspect", RUNTIME_ID]],
      [["container", "inspect", RUNTIME_ID]],
    ]);
  });

  it("rejects an engine outside the immutable managed-bootstrap scope", () => {
    const fake = engineWith([], { operation: "sandbox-lifecycle" });

    expect(() => inspect(fake.engine)).toThrow("Podman 'managed-bootstrap' command adapter");
    expect(fake.capture).not.toHaveBeenCalled();
  });

  it("rejects a non-empty expected namespace before discovering a workload", () => {
    const fake = engineWith([]);

    expect(() => inspect(fake.engine, "default")).toThrow(
      "sandbox namespace must match OpenShell v0.0.106",
    );
    expect(fake.capture).not.toHaveBeenCalled();
  });

  it("accepts an exact 255-byte OpenShell Podman container name", () => {
    const sandboxName = "n".repeat(107);
    const sandboxId = "i".repeat(128);
    const containerName = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`;
    const fake = engineWith([
      result(listOutput()),
      result(inspectOutput({ sandboxId, sandboxName })),
      result(inspectOutput({ sandboxId, sandboxName })),
    ]);

    expect(Buffer.byteLength(containerName, "utf8")).toBe(255);
    expect(inspect(fake.engine, SANDBOX_NAMESPACE, { sandboxId, sandboxName }).containerName).toBe(
      containerName,
    );
  });

  it("rejects a 256-byte OpenShell Podman container name before discovery", () => {
    const sandboxName = "n".repeat(108);
    const sandboxId = "i".repeat(128);
    const containerName = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`;
    const fake = engineWith([]);

    expect(Buffer.byteLength(containerName, "utf8")).toBe(256);
    expect(() => inspect(fake.engine, SANDBOX_NAMESPACE, { sandboxId, sandboxName })).toThrow(
      "container name exceeds OpenShell's limit",
    );
    expect(fake.capture).not.toHaveBeenCalled();
  });

  it("rejects ambiguous managed containers before inspecting either candidate", () => {
    const fake = engineWith([result(listOutput([RUNTIME_ID, "5".repeat(64)]))]);

    expect(() => inspect(fake.engine)).toThrow("found 2");
    expect(fake.capture).toHaveBeenCalledOnce();
  });

  it("rejects ownership labels that do not match the durable sandbox identity", () => {
    const fake = engineWith([
      result(listOutput()),
      result(
        inspectOutput({
          labels: {
            [PODMAN_MANAGED_LABEL]: "true",
            [PODMAN_SANDBOX_ID_LABEL]: "another-sandbox",
            [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
            [PODMAN_SANDBOX_NAMESPACE_LABEL]: SANDBOX_NAMESPACE,
            [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
          },
        }),
      ),
    ]);

    expect(() => inspect(fake.engine)).toThrow("exact OpenShell ownership");
  });

  it("rejects a namespace label from a different OpenShell ownership scope", () => {
    const fake = engineWith([
      result(listOutput()),
      result(
        inspectOutput({
          labels: {
            [PODMAN_MANAGED_LABEL]: "true",
            [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
            [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
            [PODMAN_SANDBOX_NAMESPACE_LABEL]: "another-namespace",
            [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
          },
        }),
      ),
    ]);

    expect(() => inspect(fake.engine)).toThrow("exact OpenShell ownership");
  });

  it("rejects a workspace outside NemoClaw's default OpenShell authority", () => {
    const fake = engineWith([
      result(listOutput()),
      result(
        inspectOutput({
          labels: {
            [PODMAN_MANAGED_LABEL]: "true",
            [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
            [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
            [PODMAN_SANDBOX_NAMESPACE_LABEL]: SANDBOX_NAMESPACE,
            [PODMAN_SANDBOX_WORKSPACE_LABEL]: "another-workspace",
          },
        }),
      ),
    ]);

    expect(() => inspect(fake.engine)).toThrow("exact OpenShell ownership");
  });

  it("rejects a container name outside the exact default-workspace identity", () => {
    const fake = engineWith([
      result(listOutput()),
      result(inspectOutput({ name: `openshell-${SANDBOX_NAME}-${SANDBOX_ID}` })),
    ]);

    expect(() => inspect(fake.engine)).toThrow("name does not match");
  });

  it("rejects a label value that exceeds the bounded inspect contract", () => {
    const fake = engineWith([
      result(listOutput()),
      result(
        inspectOutput({
          labels: {
            [PODMAN_MANAGED_LABEL]: "true",
            [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
            [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
            [PODMAN_SANDBOX_NAMESPACE_LABEL]: "x".repeat(64 * 1024 + 1),
            [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
          },
        }),
      ),
    ]);

    expect(() => inspect(fake.engine)).toThrow("must be a bounded string");
  });

  it("rejects an inspect response whose full runtime identity changed", () => {
    const fake = engineWith([result(listOutput()), result(inspectOutput({ id: "6".repeat(64) }))]);

    expect(() => inspect(fake.engine)).toThrow("identity changed after discovery");
  });

  it("rejects a workload that does not use the image-owned root supervisor", () => {
    const fake = engineWith([result(listOutput()), result(inspectOutput({ user: "sandbox" }))]);

    expect(() => inspect(fake.engine)).toThrow("image-owned root supervisor boundary");
  });

  it.each(["0:0", "root:root"])(
    "accepts the canonical OpenShell root supervisor identity %s",
    (user) => {
      const fake = engineWith([
        result(listOutput()),
        result(inspectOutput({ user })),
        result(inspectOutput({ user })),
      ]);

      expect(inspect(fake.engine).runtimeId).toBe(RUNTIME_ID);
    },
  );

  it("rejects a stopped held workload before replacement preparation", () => {
    const fake = engineWith([result(listOutput()), result(inspectOutput({ running: false }))]);

    expect(() => inspect(fake.engine)).toThrow("stably running");
  });

  it("rejects drift in the persisted bootstrap identity", () => {
    const fake = engineWith([
      result(listOutput()),
      result(
        inspectOutput({
          bootstrapIdentity: "7".repeat(64),
        }),
      ),
    ]);

    expect(() => inspect(fake.engine)).toThrow("bootstrap identity binding changed");
  });

  it("rejects image-content drift during the stable capture", () => {
    const fake = engineWith([
      result(listOutput()),
      result(inspectOutput()),
      result(inspectOutput({ image: OTHER_IMAGE_ID })),
    ]);

    expect(() => inspect(fake.engine)).toThrow("image content changed");
  });

  it("does not include command output in a Podman failure", () => {
    const fake = engineWith([
      result("credential-in-stdout", {
        status: 125,
        stderr: "credential-in-stderr",
        error: new Error("socket unavailable"),
      }),
    ]);

    expect(() => inspect(fake.engine)).toThrow(
      "Managed bootstrap Podman discovery failed with status 125: socket unavailable",
    );
  });
});
