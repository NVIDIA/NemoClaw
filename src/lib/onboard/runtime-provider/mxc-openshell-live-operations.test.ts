// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import type {
  RuntimeProviderNativeArtifactBootstrapPlan,
  RuntimeProviderNativeArtifactVerifyAndCreateOutcome,
} from "./contract";
import { createMxcNativeArtifactBootstrapSurface } from "./mxc-bootstrap";
import { mxcOpenShellAttachmentFixture } from "./mxc-openshell-attachment-test-fixture";
import { qualifyMxcOpenShellAttachment } from "./mxc-openshell-attachment";
import {
  projectMxcOpenShellCreateRequest,
  type MxcOpenShellCreateRequest,
} from "./mxc-openshell-create-request";
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

function labelDigest(value: string): string {
  const encoded = Buffer.from(value, "hex").toString("base64url");
  return /^[A-Za-z0-9]/u.test(encoded) ? encoded : `h${encoded}`;
}

async function request(lifecycleGeneration = "generation-7") {
  let plan: RuntimeProviderNativeArtifactBootstrapPlan | undefined;
  const workload = nativeArtifactWorkloadReceiptFixture(
    // Keep this protocol fixture independent of changing live E2E startup defaults.
    encodeManagedStartupProfile({
      schemaVersion: 1,
      agent: "openclaw",
      inference: {
        routeProvider: "inference",
        upstreamProvider: "nvidia",
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-completions",
        primaryModelRef: "inference/nvidia/nemotron-3-ultra-550b-a55b",
        compatibility: {},
        inputModalities: ["text"],
      },
      proxy: {
        managedHost: "10.200.0.1",
        managedPort: 3128,
        hostHttpUrl: "http://fixture-http-proxy.example.test:18080",
        hostHttpsUrl: "http://fixture-https-proxy.example.test:18443",
        hostNoProxy: ["localhost", "127.0.0.1", ".example.test"],
      },
      tools: { disclosure: "progressive", enabledGateways: [] },
      messaging: { plan: null },
      corporateCa: { bundleSha256: null },
      agentConfig: {
        agent: "openclaw",
        webSearch: { enabled: false, provider: "brave" },
        otel: {
          enabled: false,
          endpointUrl: "http://host.openshell.internal:4318",
          serviceName: "openclaw-gateway",
          sampleRate: 1,
        },
        agentTimeoutSeconds: 600,
        heartbeatEvery: null,
        extraAgents: { agents: [], defaults: {}, main: {} },
        deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
        minimalBootstrap: true,
      },
      dashboard: {
        agent: "openclaw",
        mode: "loopback",
        url: "http://127.0.0.1:18789",
        port: 18789,
        bindAddress: "127.0.0.1",
        wslExposure: false,
      },
      tuning: {
        contextWindow: 131072,
        maxTokens: 8192,
        reasoning: false,
        reasoningEffort: "default",
      },
    }),
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
    lifecycleGeneration,
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

function created(liveRequest: MxcOpenShellCreateRequest) {
  return {
    status: "created",
    authoritySha256: liveRequest.authoritySha256,
    providerHandle: liveRequest.providerHandle,
    sandboxName: liveRequest.sandboxName,
    lifecycleGeneration: liveRequest.lifecycleGeneration,
    artifactDigest: liveRequest.workload.artifactDigest,
    executableDigest: liveRequest.workload.executableDigest,
  } satisfies Extract<RuntimeProviderNativeArtifactVerifyAndCreateOutcome, { status: "created" }>;
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
  liveRequest: MxcOpenShellCreateRequest,
  phase = "Ready",
  labelOverrides: Record<string, string> = {},
) {
  return {
    id: "sandbox-id-1",
    name: "alpha",
    workspace: "default",
    labels: {
      "nemoclaw-provider": "mxc",
      "nemoclaw-attachment-sha256": labelDigest(fixture().authoritySha256),
      "nemoclaw-authority-sha256": labelDigest(liveRequest.authoritySha256),
      "nemoclaw-policy-sha256": labelDigest("6".repeat(64)),
      "nemoclaw-request-sha256": labelDigest(liveRequest.requestSha256),
      "nemoclaw-lifecycle-sha256": labelDigest(
        createHash("sha256").update(liveRequest.lifecycleGeneration, "utf8").digest("hex"),
      ),
      ...labelOverrides,
    },
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
      recordFailure: vi.fn(),
      ...boundary,
    },
  });
}

describe("inactive OpenShell MXC live operations", () => {
  it("binds one verified create to the exact attachment, request, policy, and gateway (#8178)", async () => {
    const liveRequest = await request();
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async () => ({ status: "completed", command: result(sandbox(liveRequest)) }),
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
    expect(input.command.timeoutMs).toBe(10 * 60_000);
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
      "nemoclaw-attachment-sha256": labelDigest(input.attachment.authoritySha256),
      "nemoclaw-authority-sha256": labelDigest(liveRequest.authoritySha256),
      "nemoclaw-policy-sha256": labelDigest("6".repeat(64)),
      "nemoclaw-request-sha256": labelDigest(liveRequest.requestSha256),
      "nemoclaw-lifecycle-sha256": labelDigest(
        createHash("sha256").update(liveRequest.lifecycleGeneration, "utf8").digest("hex"),
      ),
    });
    expect(input.command.arguments).toContain(`HOME=${liveRequest.environment.HOME}`);
    expect(liveRequest.hostEnvironmentReferences.length).toBeGreaterThan(0);
    liveRequest.hostEnvironmentReferences.forEach((name) => {
      expect(input.command.arguments.some((entry) => entry.startsWith(`${name}=`))).toBe(false);
      expect(input.command.arguments).toContain(name);
      expect(input.command.arguments[input.command.arguments.indexOf(name) - 1]).toBe("--env-from");
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("makes leading-symbol digest labels valid for create and recovery (#10585)", async () => {
    const liveRequest = await request("leading-symbol-15");
    const rawRequestLabel = Buffer.from(liveRequest.requestSha256, "hex").toString("base64url");
    expect(rawRequestLabel).toMatch(/^[-_]/u);
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async () => ({ status: "create-rejected" }),
    );
    const run = vi
      .fn<MxcOpenShellLiveHostBoundary["run"]>()
      .mockImplementationOnce(async () => result("", 1))
      .mockImplementationOnce(async () => result([]));
    const live = operations({ verifyAndRunCreate, run });

    await expect(live.verifyAndCreate(liveRequest)).resolves.toEqual({
      status: "not-created",
      reason: "create-rejected",
    });
    await expect(live.recoverCreate(liveRequest)).resolves.toEqual({ status: "absent" });

    const expected = `h${rawRequestLabel}`;
    expect(labelArguments(verifyAndRunCreate.mock.calls[0]![0].command)).toMatchObject({
      "nemoclaw-request-sha256": expected,
    });
    expect(run.mock.calls[1]![0].command.arguments).toEqual(
      expect.arrayContaining(["--selector", `nemoclaw-request-sha256=${expected}`]),
    );
    expect(expected).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u);
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

  it("records bounded create and readiness failures without command output (#8178)", async () => {
    const liveRequest = await request();
    const createFailures = vi.fn<MxcOpenShellLiveHostBoundary["recordFailure"]>();
    const failedCreate = operations({
      verifyAndRunCreate: vi.fn(async () => {
        throw new Error("credential-bearing boundary detail");
      }),
      recordFailure: createFailures,
    });

    await expect(failedCreate.verifyAndCreate(liveRequest)).resolves.toEqual({ status: "unknown" });
    expect(createFailures).toHaveBeenCalledWith({
      contractVersion: 1,
      providerId: "mxc",
      operation: "create",
      errorClass: "boundary-error",
      sandboxName: "alpha",
      lifecycleGeneration: "generation-7",
    });
    expect(JSON.stringify(createFailures.mock.calls)).not.toContain("credential-bearing");

    const readinessFailures = vi.fn<MxcOpenShellLiveHostBoundary["recordFailure"]>();
    const boundaryFailure = operations({
      run: vi.fn(async () => {
        throw new Error("host detail");
      }),
      recordFailure: readinessFailures,
    });
    await expect(
      boundaryFailure.verifyReadiness(liveRequest, created(liveRequest)),
    ).rejects.toThrow(/trusted host command failed/u);

    const invalidOutput = operations({
      run: vi.fn(async () => result("not-json")),
      recordFailure: readinessFailures,
    });
    await expect(invalidOutput.verifyReadiness(liveRequest, created(liveRequest))).rejects.toThrow(
      /invalid JSON/u,
    );
    expect(readinessFailures.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ operation: "readiness", errorClass: "boundary-error" }),
      expect.objectContaining({ operation: "readiness", errorClass: "invalid-output" }),
    ]);
  });

  it("returns an unknown create outcome when OpenShell output drifts from request authority (#8178)", async () => {
    const liveRequest = await request();
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async () => ({
        status: "completed",
        command: result(
          sandbox(liveRequest, "Ready", { "nemoclaw-request-sha256": "0".repeat(64) }),
        ),
      }),
    );

    await expect(
      operations({ verifyAndRunCreate, run: vi.fn() }).verifyAndCreate(liveRequest),
    ).resolves.toEqual({ status: "unknown" });
  });

  it("rejects lifecycle-label drift during creation and readiness (#8178)", async () => {
    const liveRequest = await request();
    const drifted = sandbox(liveRequest, "Ready", {
      "nemoclaw-lifecycle-sha256": "0".repeat(64),
    });
    const recordFailure = vi.fn<MxcOpenShellLiveHostBoundary["recordFailure"]>();
    const live = operations({
      verifyAndRunCreate: vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(async () => ({
        status: "completed",
        command: result(drifted),
      })),
      run: vi.fn(async () => result(drifted)),
      recordFailure,
    });

    await expect(live.verifyAndCreate(liveRequest)).resolves.toEqual({ status: "unknown" });
    await expect(live.verifyReadiness(liveRequest, created(liveRequest))).rejects.toThrow(
      /lifecycle authority drifted/u,
    );
    expect(recordFailure.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ operation: "create", errorClass: "identity-drift" }),
      expect.objectContaining({ operation: "readiness", errorClass: "identity-drift" }),
    ]);
  });

  it("rejects forged requests before any trusted host operation (#8178)", async () => {
    const issued = await request();
    const forged = {
      ...issued,
      driverConfigJson: '{"mxc":{"command":["cmd.exe","/c","set"]}}',
      environment: { ...issued.environment, NVIDIA_API_KEY: "not-a-real-secret" },
    } as unknown as MxcOpenShellCreateRequest;
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>();
    const run = vi.fn<MxcOpenShellLiveHostBoundary["run"]>();
    const deleteExact = vi.fn<MxcOpenShellLiveHostBoundary["deleteExact"]>();
    const recordFailure = vi.fn<MxcOpenShellLiveHostBoundary["recordFailure"]>();
    const live = operations({ verifyAndRunCreate, run, deleteExact, recordFailure });

    await expect(live.verifyAndCreate(forged)).rejects.toThrow(/not issued by the MXC provider/u);
    await expect(live.verifyReadiness(forged, created(issued))).rejects.toThrow(
      /not issued by the MXC provider/u,
    );
    await expect(live.recoverCreate(forged)).rejects.toThrow(/not issued by the MXC provider/u);
    expect(verifyAndRunCreate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(deleteExact).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("accepts readiness only from the exact request-owned sandbox (#8178)", async () => {
    const liveRequest = await request();
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async () => ({ status: "completed", command: result(sandbox(liveRequest)) }),
    );
    const run = vi.fn<MxcOpenShellLiveHostBoundary["run"]>(async () =>
      result(sandbox(liveRequest, "Ready")),
    );
    const live = operations({ verifyAndRunCreate, run });
    const createOutcome = await live.verifyAndCreate(liveRequest);
    expect(createOutcome.status).toBe("created");

    await expect(live.verifyReadiness(liveRequest, created(liveRequest))).resolves.toEqual(
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
    const liveRequest = await request();
    const run = vi
      .fn<MxcOpenShellLiveHostBoundary["run"]>()
      .mockImplementationOnce(async () => result("", 1))
      .mockImplementationOnce(async () => result([]));

    await expect(
      operations({ verifyAndRunCreate: vi.fn(), run }).recoverCreate(liveRequest),
    ).resolves.toEqual({ status: "absent" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].command.arguments).toEqual(
      expect.arrayContaining([
        "--limit",
        "2",
        "--selector",
        `nemoclaw-request-sha256=${labelDigest(liveRequest.requestSha256)}`,
      ]),
    );
  });

  it("rejects ambiguous label-scoped recovery without deleting either sandbox (#8178)", async () => {
    const liveRequest = await request();
    const first = sandbox(liveRequest);
    const run = vi
      .fn<MxcOpenShellLiveHostBoundary["run"]>()
      .mockImplementationOnce(async () => result("", 1))
      .mockImplementationOnce(async () => result([first, { ...first, id: "sandbox-id-2" }]));
    const deleteExact = vi.fn<MxcOpenShellLiveHostBoundary["deleteExact"]>();
    const recordFailure = vi.fn<MxcOpenShellLiveHostBoundary["recordFailure"]>();

    await expect(
      operations({ run, deleteExact, recordFailure }).recoverCreate(liveRequest),
    ).rejects.toThrow(/recovery identity is ambiguous/u);
    expect(deleteExact).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "list", errorClass: "identity-drift" }),
    );
  });

  it("deletes only the exact request-owned sandbox and confirms absence (#8178)", async () => {
    const liveRequest = await request();
    const verifyAndRunCreate = vi.fn<MxcOpenShellLiveHostBoundary["verifyAndRunCreate"]>(
      async () => ({ status: "completed", command: result(sandbox(liveRequest)) }),
    );
    const run = vi
      .fn<MxcOpenShellLiveHostBoundary["run"]>()
      .mockImplementationOnce(async () => result(sandbox(liveRequest)))
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
      "--expected-id",
      "sandbox-id-1",
    ]);
  });

  it("retains the request authority when exact deletion fails (#8178)", async () => {
    const liveRequest = await request();
    const recordFailure = vi.fn<MxcOpenShellLiveHostBoundary["recordFailure"]>();
    const run = vi.fn<MxcOpenShellLiveHostBoundary["run"]>(async () =>
      result(sandbox(liveRequest)),
    );
    const deleteExact = vi.fn<MxcOpenShellLiveHostBoundary["deleteExact"]>(async () =>
      result("", 1),
    );

    await expect(
      operations({ run, deleteExact, recordFailure }).recoverCreate(liveRequest),
    ).resolves.toEqual(expect.objectContaining({ status: "retained" }));
    expect(run).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "delete",
        errorClass: "nonzero-exit",
        sandboxId: "sandbox-id-1",
      }),
    );
  });

  it("retains the request authority when confirmation still finds the sandbox (#8178)", async () => {
    const liveRequest = await request();
    const recordFailure = vi.fn<MxcOpenShellLiveHostBoundary["recordFailure"]>();
    const run = vi
      .fn<MxcOpenShellLiveHostBoundary["run"]>()
      .mockImplementationOnce(async () => result(sandbox(liveRequest)))
      .mockImplementationOnce(async () => result([sandbox(liveRequest)]));
    const deleteExact = vi.fn<MxcOpenShellLiveHostBoundary["deleteExact"]>(async () => result(""));

    await expect(
      operations({ run, deleteExact, recordFailure }).recoverCreate(liveRequest),
    ).resolves.toEqual(expect.objectContaining({ status: "retained" }));
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "confirm",
        errorClass: "unknown-result",
        sandboxId: "sandbox-id-1",
      }),
    );
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

  it("retains a request-labeled sandbox from a different workspace (#8178)", async () => {
    const liveRequest = await request();
    const deleteExact = vi.fn<MxcOpenShellLiveHostBoundary["deleteExact"]>();
    const run = vi.fn<MxcOpenShellLiveHostBoundary["run"]>(async () =>
      result({ ...sandbox(liveRequest), workspace: "other" }),
    );

    await expect(operations({ run, deleteExact }).recoverCreate(liveRequest)).resolves.toEqual(
      expect.objectContaining({ status: "retained" }),
    );
    expect(run).toHaveBeenCalledOnce();
    expect(deleteExact).not.toHaveBeenCalled();
  });

  it("rejects unqualified gateway, policy, or host-operation inputs (#8178)", () => {
    const base = {
      attachment: fixture(),
      gatewayName: "windows-mxc",
      workspace: "default",
      policy: { path: "C:\\NemoClaw\\policy.yaml", sha256: "6".repeat(64) },
      boundary: {
        verifyAndRunCreate: vi.fn(),
        run: vi.fn(),
        deleteExact: vi.fn(),
        recordFailure: vi.fn(),
      },
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
