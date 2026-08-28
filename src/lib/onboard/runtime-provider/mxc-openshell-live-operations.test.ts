// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import type { RuntimeProviderNativeArtifactBootstrapPlan } from "./contract";
import { createMxcNativeArtifactBootstrapSurface } from "./mxc-bootstrap";
import { mxcOpenShellAttachmentFixture } from "./mxc-openshell-attachment-test-fixture";
import { qualifyMxcOpenShellAttachment } from "./mxc-openshell-attachment";
import { projectMxcOpenShellCreateRequest } from "./mxc-openshell-create-request";
import {
  createMxcOpenShellLiveOperations,
  type MxcOpenShellLiveCommand,
  type MxcOpenShellLiveCommandResult,
  type MxcOpenShellLiveHostBoundary,
} from "./mxc-openshell-live-operations";

const REQUIRED_ENVIRONMENT = [
  "HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

async function request() {
  let plan: RuntimeProviderNativeArtifactBootstrapPlan | undefined;
  const workload = nativeArtifactWorkloadReceiptFixture(
    encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
  );
  const surface = createMxcNativeArtifactBootstrapSurface({
    verifyAndCreate: async (value) => {
      plan = value;
      return { status: "not-created", reason: "create-rejected" };
    },
    verifyReadiness: async () => {
      throw new Error("unreachable");
    },
    recoverCreate: async () => ({ status: "absent" }),
  });
  await surface.run({
    providerId: "mxc",
    sandboxName: "alpha",
    lifecycleGeneration: "generation-7",
    driveRoot: "C:\\",
    artifactRoot: "C:\\openclaw-2026-7-1",
    workload: {
      ...workload,
      launch: { ...workload.launch, environmentNames: REQUIRED_ENVIRONMENT },
    },
  });
  return projectMxcOpenShellCreateRequest(plan!);
}

function fixture() {
  const source = mxcOpenShellAttachmentFixture();
  return qualifyMxcOpenShellAttachment(source.authority, source.observation);
}

function result(stdout: unknown, status = 0): MxcOpenShellLiveCommandResult {
  return {
    status,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
  };
}

function labelArguments(command: MxcOpenShellLiveCommand): Record<string, string> {
  const labels: Record<string, string> = {};
  const values = command.arguments.flatMap((argument, index) =>
    argument === "--label" ? [command.arguments[index + 1]!] : [],
  );
  values.forEach((value) => {
    const separator = value.indexOf("=");
    labels[value.slice(0, separator)] = value.slice(separator + 1);
  });
  return labels;
}

function sandbox(
  command: MxcOpenShellLiveCommand,
  phase = "Ready",
  labelOverrides: Record<string, string> = {},
) {
  return {
    id: "sandbox-id-1",
    name: "alpha",
    workspace: "default",
    labels: { ...labelArguments(command), ...labelOverrides },
    phase,
  };
}

function operations(boundary: Partial<MxcOpenShellLiveHostBoundary>) {
  return createMxcOpenShellLiveOperations({
    attachment: fixture(),
    gatewayName: "windows-mxc",
    workspace: "default",
    policy: {
      path: "C:\\NemoClaw\\policy.yaml",
      sha256: "6".repeat(64),
    },
    boundary: {
      verifyAndRunCreate: vi.fn(),
      run: vi.fn(),
      deleteExact: vi.fn(),
      ...boundary,
    },
  });
}

describe("inactive OpenShell MXC live operations", () => {
  it("binds one verified create to the exact attachment, request, policy, and gateway (#8178)", async () => {
    const liveRequest = await request();
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async (input) => ({ status: "completed", command: result(sandbox(input.command)) }),
    );
    const run = vi.fn<MxcOpenShellLiveHostBoundary["run"]>();

    await expect(
      operations({ verifyAndRunCreate, run }).verifyAndCreate(liveRequest),
    ).resolves.toEqual(
      expect.objectContaining({ status: "created", authoritySha256: liveRequest.authoritySha256 }),
    );

    const input = verifyAndRunCreate.mock.calls[0]![0];
    expect(input.attachment.components.cli.path).toBe("C:\\OpenShell\\bin\\openshell.exe");
    expect(input.policy).toEqual({
      path: "C:\\NemoClaw\\policy.yaml",
      sha256: "6".repeat(64),
    });
    expect(input.command.executablePath).toBe(input.attachment.components.cli.path);
    expect(input.command.arguments).toEqual(
      expect.arrayContaining([
        "--gateway",
        "windows-mxc",
        "--workspace",
        "default",
        "sandbox",
        "create",
        "--name",
        "alpha",
        "--policy",
        "C:\\NemoClaw\\policy.yaml",
        "--driver-config-json",
        liveRequest.driverConfigJson,
        "--no-tty",
        "--no-auto-providers",
        "--output",
        "json",
      ]),
    );
    expect(labelArguments(input.command)).toMatchObject({
      "nemoclaw-provider": "mxc",
      "nemoclaw-attachment-sha256": input.attachment.authoritySha256,
      "nemoclaw-authority-sha256": liveRequest.authoritySha256,
      "nemoclaw-policy-sha256": "6".repeat(64),
      "nemoclaw-request-sha256": liveRequest.requestSha256,
    });
    expect(input.command.arguments).toContain(`HOME=${liveRequest.environment.HOME}`);
    expect(input.command.arguments.some((entry) => entry.startsWith("PATH="))).toBe(false);
    expect(JSON.stringify(input.command)).not.toContain("NVIDIA_API_KEY");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not create when the trusted boundary rejects artifact verification (#8178)", async () => {
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async () => ({ status: "artifact-verification-failed" }),
    );

    await expect(
      operations({ verifyAndRunCreate, run: vi.fn() }).verifyAndCreate(await request()),
    ).resolves.toEqual({ status: "not-created", reason: "artifact-verification-failed" });
  });

  it.each([
    [
      "a pre-mutation rejection",
      { status: "create-rejected" } as const,
      { status: "not-created", reason: "create-rejected" },
    ],
    [
      "a nonzero mutation command",
      { status: "completed", command: result("", 1) } as const,
      { status: "unknown" },
    ],
  ])(
    "classifies %s without claiming an absent sandbox (#8178)",
    async (_label, outcome, expected) => {
      const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
        async () => outcome,
      );

      await expect(
        operations({ verifyAndRunCreate }).verifyAndCreate(await request()),
      ).resolves.toEqual(expected);
    },
  );

  it("returns an unknown create outcome when OpenShell output drifts from request authority (#8178)", async () => {
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async (input) => ({
        status: "completed",
        command: result(
          sandbox(input.command, "Ready", { "nemoclaw-request-sha256": "0".repeat(64) }),
        ),
      }),
    );

    await expect(
      operations({ verifyAndRunCreate, run: vi.fn() }).verifyAndCreate(await request()),
    ).resolves.toEqual({ status: "unknown" });
  });

  it("accepts readiness only from the exact request-owned sandbox (#8178)", async () => {
    const liveRequest = await request();
    let createCommand: MxcOpenShellLiveCommand | undefined;
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async (input) => {
        createCommand = input.command;
        return { status: "completed", command: result(sandbox(input.command)) };
      },
    );
    const run = vi.fn<MxcOpenShellLiveHostBoundary["run"]>(async () =>
      result(sandbox(createCommand!, "Ready")),
    );
    const live = operations({ verifyAndRunCreate, run });
    const created = await live.verifyAndCreate(liveRequest);
    expect(created.status).toBe("created");

    await expect(live.verifyReadiness(liveRequest, created as never)).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        executableDigest: liveRequest.workload.executableDigest,
      }),
    );
    expect(run.mock.calls[0]![0].command.arguments).toEqual([
      "--gateway",
      "windows-mxc",
      "--workspace",
      "default",
      "sandbox",
      "get",
      "alpha",
      "--output",
      "json",
    ]);
  });

  it("reports absence without attempting deletion (#8178)", async () => {
    const run = vi
      .fn<MxcOpenShellLiveHostBoundary["run"]>()
      .mockImplementationOnce(async () => result("", 1))
      .mockImplementationOnce(async () => result([]));

    await expect(
      operations({ verifyAndRunCreate: vi.fn(), run }).recoverCreate(await request()),
    ).resolves.toEqual({ status: "absent" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].command.arguments).toEqual(
      expect.arrayContaining([
        "--limit",
        "2",
        "--selector",
        expect.stringMatching(/^nemoclaw-request-sha256=[a-f0-9]{64}$/u),
      ]),
    );
  });

  it("deletes only the exact request-owned sandbox and confirms absence (#8178)", async () => {
    const liveRequest = await request();
    let createCommand: MxcOpenShellLiveCommand | undefined;
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async (input) => {
        createCommand = input.command;
        return { status: "completed", command: result(sandbox(input.command)) };
      },
    );
    const run = vi
      .fn<MxcOpenShellLiveHostBoundary["run"]>()
      .mockImplementationOnce(async () => result(sandbox(createCommand!)))
      .mockImplementationOnce(async () => result([]));
    const deleteExact = vi.fn<MxcOpenShellLiveHostBoundary["deleteExact"]>(async () =>
      result("", 0),
    );
    const live = operations({ verifyAndRunCreate, run, deleteExact });
    await live.verifyAndCreate(liveRequest);

    await expect(live.recoverCreate(liveRequest)).resolves.toEqual(
      expect.objectContaining({ status: "removed", authoritySha256: liveRequest.authoritySha256 }),
    );
    expect(deleteExact.mock.calls[0]![0]).toMatchObject({
      sandboxId: "sandbox-id-1",
      request: liveRequest,
    });
    expect(deleteExact.mock.calls[0]![0].command.arguments).toEqual([
      "--gateway",
      "windows-mxc",
      "--workspace",
      "default",
      "sandbox",
      "delete",
      "alpha",
    ]);
  });

  it("retains a same-name sandbox whose lifecycle authority does not match (#8178)", async () => {
    const liveRequest = await request();
    const deleteExact = vi.fn<MxcOpenShellLiveHostBoundary["deleteExact"]>();
    const run = vi.fn<MxcOpenShellLiveHostBoundary["run"]>(async () =>
      result({
        id: "other-id",
        name: "alpha",
        workspace: "default",
        labels: { "nemoclaw-provider": "mxc" },
        phase: "Ready",
      }),
    );

    await expect(
      operations({ verifyAndRunCreate: vi.fn(), run, deleteExact }).recoverCreate(liveRequest),
    ).resolves.toEqual(expect.objectContaining({ status: "retained" }));
    expect(run).toHaveBeenCalledOnce();
    expect(deleteExact).not.toHaveBeenCalled();
  });

  it("rejects unqualified gateway, policy, or host-operation inputs (#8178)", () => {
    const base = {
      attachment: fixture(),
      gatewayName: "windows-mxc",
      workspace: "default",
      policy: { path: "C:\\NemoClaw\\policy.yaml", sha256: "6".repeat(64) },
      boundary: { verifyAndRunCreate: vi.fn(), run: vi.fn(), deleteExact: vi.fn() },
    };

    expect(() => createMxcOpenShellLiveOperations({ ...base, gatewayName: "bad gateway" })).toThrow(
      /gateway name is invalid/u,
    );
    expect(() =>
      createMxcOpenShellLiveOperations({
        ...base,
        policy: { ...base.policy, path: "\\\\host\\policy.yaml" },
      }),
    ).toThrow(/local-drive Windows path/u);
    expect(() => createMxcOpenShellLiveOperations({ ...base, boundary: {} as never })).toThrow(
      /trusted live host boundary is required/u,
    );
  });
});
