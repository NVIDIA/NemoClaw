// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import type { RuntimeProviderNativeArtifactBootstrapPlan } from "./contract";
import { createMxcNativeArtifactBootstrapSurface } from "./mxc-bootstrap";
import {
  mxcOpenShellAttachmentDigestMap,
  mxcOpenShellAttachmentFixture,
  mxcOpenShellAttachmentObservationRequest,
  mxcOpenShellDistributionTestFixture,
} from "./mxc-openshell-attachment-test-fixture";
import { qualifyMxcOpenShellAttachment } from "./mxc-openshell-attachment";
import {
  projectMxcOpenShellCreateRequest,
  type MxcOpenShellCreateRequest,
} from "./mxc-openshell-create-request";
import type { MxcOpenShellLiveCommand } from "./mxc-openshell-live-operations";
import {
  createMxcWindowsOpenShellExecutor,
  type MxcWindowsOpenShellArtifactTree,
  type MxcWindowsOpenShellExecutorRuntime,
} from "./mxc-windows-openshell-executor";

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

async function issuedRequest(): Promise<MxcOpenShellCreateRequest> {
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

function attachment() {
  const fixture = mxcOpenShellAttachmentFixture();
  return qualifyMxcOpenShellAttachment(fixture.authority, fixture.observation);
}

function createCommand(request: MxcOpenShellCreateRequest): MxcOpenShellLiveCommand {
  return {
    executablePath: attachment().components.cli.path,
    arguments: [
      "--gateway",
      "local",
      "--workspace",
      "default",
      "sandbox",
      "create",
      "--name",
      request.sandboxName,
    ],
    timeoutMs: 30_000,
  };
}

function missingTestDigest(): never {
  throw new Error("unknown test path");
}

function runtime(
  request: MxcOpenShellCreateRequest,
  overrides: Partial<MxcWindowsOpenShellExecutorRuntime> = {},
) {
  const digests = mxcOpenShellAttachmentDigestMap();
  const release = vi.fn(async () => undefined);
  const loss = new Promise<void>(() => undefined);
  const tree: MxcWindowsOpenShellArtifactTree = {
    directories: [request.workload.artifactRoot],
    files: [
      {
        path: request.workload.executablePath,
        sha256: request.workload.executableDigest.slice("sha256:".length),
      },
    ],
    sha256: request.workload.artifactDigest.slice("sha256:".length),
  };
  const value: MxcWindowsOpenShellExecutorRuntime = {
    platform: "win32",
    environment: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      OPENAI_API_KEY: "must-not-reach-openshell",
    },
    observeFileDigest: vi.fn(async (filePath) => {
      return digests.get(filePath) ?? missingTestDigest();
    }),
    observeArtifactTree: vi.fn(() => tree),
    acquirePins: vi.fn(async () => ({
      isActive: () => true,
      waitForLoss: () => loss,
      release,
    })),
    runCommand: vi.fn(async () => ({
      status: 0,
      stdout: JSON.stringify({ id: "sandbox-id-1" }),
      stderr: "",
    })),
    ...overrides,
  };
  return { release, runtime: value, tree };
}

function executor(testRuntime: MxcWindowsOpenShellExecutorRuntime) {
  const distribution = mxcOpenShellDistributionTestFixture();
  return createMxcWindowsOpenShellExecutor({
    distributionAuthority: distribution.authority,
    observationRequest: mxcOpenShellAttachmentObservationRequest(distribution.observation),
    runtime: testRuntime,
  });
}

describe("inactive trusted Windows OpenShell executor", () => {
  it("rejects unsupported hosts and copied provider authority before observation (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);
    const distribution = mxcOpenShellDistributionTestFixture();

    expect(() =>
      createMxcWindowsOpenShellExecutor({
        distributionAuthority: distribution.authority,
        observationRequest: mxcOpenShellAttachmentObservationRequest(distribution.observation),
        runtime: { ...test.runtime, platform: "linux" },
      }),
    ).toThrow(/requires Windows/u);
    expect(() =>
      createMxcWindowsOpenShellExecutor({
        distributionAuthority: { ...distribution.authority },
        observationRequest: mxcOpenShellAttachmentObservationRequest(distribution.observation),
        runtime: test.runtime,
      }),
    ).toThrow(/not provider-owned/u);
    expect(test.runtime.observeFileDigest).not.toHaveBeenCalled();
  });

  it("pins the qualified distribution, policy, and exact artifact through create (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);
    const boundary = executor(test.runtime);

    await expect(
      boundary.verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(test.runtime.acquirePins).toHaveBeenCalledOnce();
    const pins = vi.mocked(test.runtime.acquirePins).mock.calls[0]![0];
    expect(pins.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: attachment().components.cli.path }),
        expect.objectContaining({ path: request.workload.executablePath }),
        { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
      ]),
    );
    expect(test.runtime.runCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(test.runtime.runCommand).mock.calls[0]![1]).not.toHaveProperty(
      "OPENAI_API_KEY",
    );
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("fails before mutation when the fresh attachment observation drifts (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request, {
      observeFileDigest: vi.fn(async () => "f".repeat(64)),
    });

    await expect(
      executor(test.runtime).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      }),
    ).resolves.toEqual({ status: "artifact-verification-failed" });
    expect(test.runtime.acquirePins).not.toHaveBeenCalled();
    expect(test.runtime.runCommand).not.toHaveBeenCalled();
  });

  it("fails closed when the artifact changes after the pin lease is acquired (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);
    vi.mocked(test.runtime.observeArtifactTree)
      .mockReturnValueOnce(test.tree)
      .mockReturnValueOnce({ ...test.tree, sha256: "e".repeat(64) });

    await expect(
      executor(test.runtime).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      }),
    ).resolves.toEqual({ status: "artifact-verification-failed" });
    expect(test.runtime.runCommand).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("classifies an inconclusive create command as unknown without retrying (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request, {
      runCommand: vi.fn(async () => ({ status: null, stdout: "", stderr: "" })),
    });

    await expect(
      executor(test.runtime).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      }),
    ).resolves.toEqual({ status: "unknown" });
    expect(test.runtime.runCommand).toHaveBeenCalledOnce();
  });

  it.each(["command launch failure", "pin release failure"] as const)(
    "classifies a %s after the pin gate as unknown (#10584)",
    async (failure) => {
      const request = await issuedRequest();
      const test = runtime(
        request,
        failure === "command launch failure"
          ? {
              runCommand: vi.fn(async () => {
                throw new Error("sensitive child-process error");
              }),
            }
          : {},
      );
      test.release.mockImplementation(
        failure === "pin release failure"
          ? async () => {
              throw new Error("sensitive release error");
            }
          : async () => undefined,
      );

      await expect(
        executor(test.runtime).verifyAndRunCreate({
          attachment: attachment(),
          policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
          request,
          command: createCommand(request),
        }),
      ).resolves.toEqual({ status: "unknown" });
    },
  );

  it("aborts an OpenShell command when stable-file pinning is lost (#10584)", async () => {
    const request = await issuedRequest();
    let reportLoss: (() => void) | undefined;
    let active = true;
    const loss = new Promise<void>((resolve) => {
      reportLoss = resolve;
    });
    const release = vi.fn(async () => undefined);
    const runCommand = vi.fn(
      async (
        _command: MxcOpenShellLiveCommand,
        _environment: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) =>
        await new Promise<{ status: null; stdout: string; stderr: string }>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ status: null, stdout: "", stderr: "" }),
            { once: true },
          );
          active = false;
          reportLoss?.();
        }),
    );
    const test = runtime(request, {
      acquirePins: vi.fn(async () => ({
        isActive: () => active,
        waitForLoss: () => loss,
        release,
      })),
      runCommand,
    });

    await expect(
      executor(test.runtime).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      }),
    ).resolves.toEqual({ status: "unknown" });
    expect(runCommand.mock.calls[0]![2].aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("requalifies and pins the installation for a readiness inspection (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);

    await expect(
      executor(test.runtime).run({
        attachment: attachment(),
        command: {
          executablePath: attachment().components.cli.path,
          arguments: ["sandbox", "get", request.sandboxName, "--output", "json"],
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({ status: 0 });
    expect(test.runtime.observeFileDigest).toHaveBeenCalledTimes(5);
    expect(test.runtime.acquirePins).toHaveBeenCalledOnce();
    expect(test.runtime.runCommand).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("rejects direct MXC execution even when its binary belongs to the receipt (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);

    await expect(
      executor(test.runtime).run({
        attachment: attachment(),
        command: {
          executablePath: attachment().components.wxcExec.path,
          arguments: ["sandbox", "get", request.sandboxName],
          timeoutMs: 30_000,
        },
      }),
    ).rejects.toThrow(/only the qualified OpenShell CLI/u);
    expect(test.runtime.acquirePins).not.toHaveBeenCalled();
    expect(test.runtime.runCommand).not.toHaveBeenCalled();
  });

  it("rejects commands outside the bounded OpenShell operation before execution (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);
    const boundary = executor(test.runtime);

    await expect(
      boundary.run({
        attachment: attachment(),
        command: {
          executablePath: attachment().components.cli.path,
          arguments: ["sandbox", "delete", "alpha"],
          timeoutMs: 30_000,
        },
      }),
    ).rejects.toThrow(/outside the allowed operation/u);
    expect(test.runtime.acquirePins).not.toHaveBeenCalled();
    expect(test.runtime.runCommand).not.toHaveBeenCalled();
  });

  it("refuses name-only deletion when OpenShell cannot bind it to the exact sandbox ID (#10584)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);

    await expect(
      executor(test.runtime).deleteExact({
        attachment: attachment(),
        request,
        sandboxId: "sandbox-id-1",
        command: {
          executablePath: attachment().components.cli.path,
          arguments: ["sandbox", "delete", request.sandboxName],
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toEqual({ status: 1, stdout: "", stderr: "" });
    expect(test.runtime.runCommand).not.toHaveBeenCalled();
  });
});
