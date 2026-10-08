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
import type {
  MxcOpenShellLiveCommand,
  MxcOpenShellLiveFailureRecord,
} from "./mxc-openshell-live-operations";
import {
  createMxcWindowsOpenShellExecutor,
  MxcWindowsOpenShellExecutorError,
  mxcWindowsOpenShellPinTimeoutMs,
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

async function issuedRequest(
  environmentNames: readonly string[] = REQUIRED_ENVIRONMENT,
): Promise<MxcOpenShellCreateRequest> {
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
      launch: { ...workload.launch, environmentNames },
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
      XDG_CONFIG_HOME: "C:\\qualification\\config",
      XDG_STATE_HOME: "C:\\qualification\\state",
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

function executor(
  testRuntime: MxcWindowsOpenShellExecutorRuntime,
  allowDiagnosticNameDeletion = false,
  environmentReferences: readonly string[] = ["PATH"],
  recordFailure?: (record: MxcOpenShellLiveFailureRecord) => void,
) {
  const distribution = mxcOpenShellDistributionTestFixture();
  return createMxcWindowsOpenShellExecutor({
    ...{ allowDiagnosticNameDeletion },
    distributionAuthority: distribution.authority,
    observationRequest: mxcOpenShellAttachmentObservationRequest(distribution.observation),
    environmentReferences,
    runtime: testRuntime,
    recordFailure,
  });
}

describe("inactive trusted Windows OpenShell executor", () => {
  it("scales pin acquisition for large Windows artifact trees within a fixed bound (#10585)", () => {
    expect(mxcWindowsOpenShellPinTimeoutMs({ directories: [], files: [] })).toBe(60_000);
    expect(
      mxcWindowsOpenShellPinTimeoutMs({
        directories: Array.from({ length: 2_427 }, () => "directory"),
        files: Array.from({ length: 33_817 }, () => ({ path: "file", sha256: "a" })),
      }),
    ).toBe(10 * 60_000);
    expect(
      mxcWindowsOpenShellPinTimeoutMs({
        directories: Array.from({ length: 100_000 }, () => "directory"),
        files: [],
      }),
    ).toBe(10 * 60_000);
  });

  it.each([
    {
      stage: "attachment",
      errorClass: "boundary-error",
      status: "artifact-verification-failed",
      runs: 0,
      releases: 0,
      configure(test: ReturnType<typeof runtime>, failure: Error) {
        vi.mocked(test.runtime.observeFileDigest).mockRejectedValue(failure);
      },
    },
    {
      stage: "artifact-tree",
      errorClass: "boundary-error",
      status: "artifact-verification-failed",
      runs: 0,
      releases: 0,
      configure(test: ReturnType<typeof runtime>, failure: Error) {
        vi.mocked(test.runtime.observeArtifactTree).mockImplementation(() => {
          throw failure;
        });
      },
    },
    {
      stage: "artifact-tree",
      errorClass: "identity-drift",
      status: "artifact-verification-failed",
      runs: 0,
      releases: 0,
      configure(test: ReturnType<typeof runtime>) {
        vi.mocked(test.runtime.observeArtifactTree).mockReturnValue({
          ...test.tree,
          sha256: "f".repeat(64),
        });
      },
    },
    {
      stage: "pin-acquire",
      errorClass: "boundary-error",
      status: "artifact-verification-failed",
      runs: 0,
      releases: 0,
      configure(test: ReturnType<typeof runtime>, failure: Error) {
        vi.mocked(test.runtime.acquirePins).mockRejectedValue(failure);
      },
    },
    {
      stage: "pin-acquire",
      errorClass: "timeout",
      status: "artifact-verification-failed",
      runs: 0,
      releases: 0,
      configure(test: ReturnType<typeof runtime>, failure: Error) {
        vi.mocked(test.runtime.acquirePins).mockRejectedValue(
          new MxcWindowsOpenShellExecutorError(failure.message, "not-started", {
            stage: "pin-acquire",
            errorClass: "timeout",
          }),
        );
      },
    },
    {
      stage: "pinned-tree",
      errorClass: "boundary-error",
      status: "artifact-verification-failed",
      runs: 0,
      releases: 1,
      configure(test: ReturnType<typeof runtime>, failure: Error) {
        vi.mocked(test.runtime.observeArtifactTree)
          .mockReturnValueOnce(test.tree)
          .mockImplementationOnce(() => {
            throw failure;
          });
      },
    },
    {
      stage: "pin-release",
      errorClass: "boundary-error",
      status: "unknown",
      runs: 1,
      releases: 1,
      configure(test: ReturnType<typeof runtime>, failure: Error) {
        test.release.mockRejectedValue(failure);
      },
    },
  ] as const)(
    "records sanitized $stage verification failures classified as $errorClass (#10585)",
    async ({ stage, errorClass, status, runs, releases, configure }) => {
      const request = await issuedRequest();
      const test = runtime(request);
      const secret = "must-not-log-token-or-private-path";
      const failure = new Error(secret);
      configure(test, failure);
      const recordFailure = vi.fn();
      const result = await executor(
        test.runtime,
        false,
        ["PATH"],
        recordFailure,
      ).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      });
      expect(result.status).toBe(status);
      expect(recordFailure).toHaveBeenCalledOnce();
      expect(recordFailure).toHaveBeenCalledWith({
        contractVersion: 1,
        providerId: "mxc",
        operation: "create",
        errorClass,
        sandboxName: request.sandboxName,
        lifecycleGeneration: request.lifecycleGeneration,
        verification: { stage, elapsedMs: expect.any(Number) },
      });
      const recorded = recordFailure.mock.calls[0]![0];
      expect(recorded.verification.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(recorded)).not.toContain(secret);
      expect(test.runtime.runCommand).toHaveBeenCalledTimes(runs);
      expect(test.release).toHaveBeenCalledTimes(releases);
    },
  );

  it("keeps a pre-create rejection when its diagnostic recorder throws (#10585)", async () => {
    const request = await issuedRequest();
    const test = runtime(request, {
      acquirePins: vi.fn(async () => {
        throw new Error("private diagnostic");
      }),
    });
    const recordFailure = vi.fn(() => {
      throw new Error("recorder failed");
    });
    await expect(
      executor(test.runtime, false, ["PATH"], recordFailure).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      }),
    ).resolves.toEqual({ status: "artifact-verification-failed" });
    expect(recordFailure).toHaveBeenCalledOnce();
    expect(test.runtime.runCommand).not.toHaveBeenCalled();
  });

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
    expect(() =>
      createMxcWindowsOpenShellExecutor({
        distributionAuthority: distribution.authority,
        observationRequest: mxcOpenShellAttachmentObservationRequest(distribution.observation),
        environment: { HOME: "C:\\qualification-home" },
        runtime: test.runtime,
      }),
    ).toThrow(/mutually exclusive/u);
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
    expect(vi.mocked(test.runtime.runCommand).mock.calls[0]![1]).toMatchObject({
      XDG_CONFIG_HOME: "C:\\qualification\\config",
      XDG_STATE_HOME: "C:\\qualification\\state",
    });
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("passes only explicitly authorized host environment references to OpenShell (#10585)", async () => {
    const referenceName = "NEMOCLAW_QUALIFICATION_VALUE";
    const referenceValue = "qualification-value";
    const request = await issuedRequest([...REQUIRED_ENVIRONMENT, referenceName]);
    const test = runtime(request, {
      environment: {
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
        [referenceName]: referenceValue,
        OPENAI_API_KEY: "must-not-reach-openshell",
      },
    });
    const operation = {
      attachment: attachment(),
      policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
      request,
      command: createCommand(request),
    };

    await expect(executor(test.runtime).verifyAndRunCreate(operation)).resolves.toEqual({
      status: "artifact-verification-failed",
    });
    expect(test.runtime.runCommand).not.toHaveBeenCalled();

    await expect(
      executor(test.runtime, false, request.hostEnvironmentReferences).verifyAndRunCreate(
        operation,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    const commandEnvironment = vi.mocked(test.runtime.runCommand).mock.calls[0]![1];
    expect(commandEnvironment[referenceName]).toBe(referenceValue);
    expect(commandEnvironment).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("permits the bounded MXC relay-readiness timeout and rejects anything longer (#10585)", async () => {
    const request = await issuedRequest();
    const accepted = runtime(request);
    const command = { ...createCommand(request), timeoutMs: 10 * 60_000 };

    await expect(
      executor(accepted.runtime).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(accepted.runtime.runCommand).toHaveBeenCalledWith(
      command,
      expect.anything(),
      expect.any(AbortSignal),
    );

    const rejected = runtime(request);
    await expect(
      executor(rejected.runtime).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: { ...command, timeoutMs: 10 * 60_000 + 1 },
      }),
    ).resolves.toEqual({ status: "artifact-verification-failed" });
    expect(rejected.runtime.runCommand).not.toHaveBeenCalled();
  });

  it("preserves an observed nonzero create result for bounded provider diagnostics (#10585)", async () => {
    const request = await issuedRequest();
    const test = runtime(request, {
      runCommand: vi.fn(async () => ({ status: 1, stdout: "", stderr: "sensitive detail" })),
    });

    await expect(
      executor(test.runtime).verifyAndRunCreate({
        attachment: attachment(),
        policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
        request,
        command: createCommand(request),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      command: { status: 1 },
    });
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

  it("rejects a delete command that is not bound to the exact sandbox ID (#10584)", async () => {
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
    ).rejects.toThrow(/not bound to the exact immutable sandbox ID/u);
    expect(test.runtime.runCommand).not.toHaveBeenCalled();
  });

  it("runs deletion through OpenShell with the exact immutable sandbox ID (#10585)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);
    const command: MxcOpenShellLiveCommand = {
      executablePath: attachment().components.cli.path,
      arguments: [
        "--gateway",
        "local",
        "--workspace",
        "default",
        "sandbox",
        "delete",
        request.sandboxName,
        "--expected-id",
        "sandbox-id-1",
      ],
      timeoutMs: 30_000,
    };

    await expect(
      executor(test.runtime).deleteExact({
        attachment: attachment(),
        request,
        sandboxId: "sandbox-id-1",
        command,
      }),
    ).resolves.toMatchObject({ status: 0 });
    expect(test.runtime.runCommand).toHaveBeenCalledWith(
      command,
      expect.not.objectContaining({ OPENAI_API_KEY: expect.anything() }),
      expect.any(AbortSignal),
    );
  });

  it("keeps immutable-ID deletion when a caller supplies the retired diagnostic option (#10585)", async () => {
    const request = await issuedRequest();
    const test = runtime(request);

    await expect(
      executor(test.runtime, true).deleteExact({
        attachment: attachment(),
        request,
        sandboxId: "sandbox-id-1",
        command: {
          executablePath: attachment().components.cli.path,
          arguments: ["sandbox", "delete", request.sandboxName, "--expected-id", "sandbox-id-1"],
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({ status: 0 });
    expect(test.runtime.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: ["sandbox", "delete", request.sandboxName, "--expected-id", "sandbox-id-1"],
      }),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });
});
