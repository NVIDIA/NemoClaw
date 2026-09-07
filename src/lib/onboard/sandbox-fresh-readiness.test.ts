// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
  printReadinessFailure: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  verifyGpuSandboxAccessAfterReady: vi.fn(),
  createDockerGpuSandboxCreatePatch: vi.fn(),
  printSandboxCreateFailureDiagnostics: vi.fn(),
  collectDockerGpuPatchDiagnostics: vi.fn(),
  queryOpenShellDockerSandboxContainers: vi.fn(),
  queryOpenShellDockerSandboxRuntimeSnapshot: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({
  streamSandboxCreate: mocks.streamSandboxCreate,
}));

vi.mock("./docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
  verifyGpuSandboxAccessAfterReady: mocks.verifyGpuSandboxAccessAfterReady,
}));

vi.mock("./docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
}));

vi.mock("./sandbox-create-failure", () => ({
  printSandboxCreateFailureDiagnostics: mocks.printSandboxCreateFailureDiagnostics,
}));

vi.mock("./docker-gpu-patch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-gpu-patch")>()),
  collectDockerGpuPatchDiagnostics: mocks.collectDockerGpuPatchDiagnostics,
}));

vi.mock("./openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxContainers: mocks.queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot: mocks.queryOpenShellDockerSandboxRuntimeSnapshot,
}));

import {
  createGpuPatchFixture,
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow, type SandboxGpuCreateFlowDeps } from "./sandbox-gpu-create-flow";

type OpenShellResult = ReturnType<SandboxGpuCreateFlowDeps["runOpenshell"]>;

const SANDBOX_NOT_READY_OUTPUT =
  `Error:   × code: 'The system is not in a state required for the operation's\n` +
  '  │ execution\', message: "sandbox is not ready"\n';
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readySandboxGetResult(): OpenShellResult {
  return {
    status: 0,
    stdout: "Name: alpha\nId: alpha-sandbox-id\nState: Ready\n",
    stderr: "",
  };
}

function createSequencedOpenShellRunner(
  entries: Array<[string, OpenShellResult[]]>,
): SandboxGpuCreateFlowDeps["runOpenshell"] {
  const resultsByCommand = new Map(entries);
  return (args) =>
    resultsByCommand.get(args.join(" "))?.shift() ?? { status: 0, stdout: "", stderr: "" };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit:1");
  });
}

function timedOutOpenShellResult(stderr = ""): OpenShellResult {
  const error = new Error("spawn openshell timed out") as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return {
    status: null,
    stdout: "",
    stderr,
    error,
    signal: "SIGKILL",
  } as OpenShellResult;
}

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(() => {
  resetGpuFlowMocks();
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("fresh sandbox executable readiness", () => {
  it("does not collect name-scoped diagnostics after an unverified hard failure (#10412)", async () => {
    const order: string[] = [];
    const patch = createGpuPatchFixture();
    patch.rollbackManagedStartupAfterCreateFailure.mockImplementation(() => {
      order.push("rollback");
    });
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.streamSandboxCreate.mockResolvedValue({
      status: 1,
      output: "sandbox create failed",
      sawProgress: true,
    });
    const input = createInput();
    mockExit();

    const deps = createDeps();
    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    expect({
      diagnosticCalls: mocks.printSandboxCreateFailureDiagnostics.mock.calls,
      identityNotice: vi
        .mocked(console.error)
        .mock.calls.flat()
        .join("\n")
        .includes("no durable sandbox identity was verified"),
      order,
    }).toEqual({
      diagnosticCalls: [],
      identityNotice: true,
      order: ["rollback"],
    });
  });

  it("keeps a transient executable not-ready response inside the bounded wait (#9050)", async () => {
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get -g nemoclaw alpha", [readySandboxGetResult(), readySandboxGetResult()]],
        [
          "sandbox exec -g nemoclaw --name alpha -- true",
          [
            {
              status: 1,
              stdout: "",
              stderr: SANDBOX_NOT_READY_OUTPUT,
            },
            { status: 0, stdout: "", stderr: "" },
          ],
        ],
      ]),
    );

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).resolves.toMatchObject({
      route: "native",
    });

    expect(
      vi
        .mocked(deps.runOpenshell)
        .mock.calls.filter(
          ([args]) => args.join(" ") === "sandbox exec -g nemoclaw --name alpha -- true",
        ),
    ).toHaveLength(2);
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("diagnostics unavailable");
      },
    ],
    ["returns null", () => null],
  ])("rolls back when terminal readiness diagnostics %s (#9050)", async (_label, runDiagnostics) => {
    const deps = createDeps();
    const patch = createGpuPatchFixture();
    const order: string[] = [];
    patch.rollbackManagedStartupAfterCreateFailure.mockImplementation(() => {
      order.push("rollback");
    });
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    mocks.printSandboxCreateFailureDiagnostics.mockImplementationOnce(() => {
      order.push("diagnostics");
      return runDiagnostics();
    });
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get -g nemoclaw alpha", [readySandboxGetResult()]],
        [
          "sandbox exec -g nemoclaw --name alpha -- true",
          [{ status: 1, stdout: "", stderr: "permission denied" }],
        ],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect({
      diagnosticCall: mocks.printSandboxCreateFailureDiagnostics.mock.calls[0],
      diagnosticUnavailable: vi
        .mocked(console.error)
        .mock.calls.flat()
        .join("\n")
        .includes("Sandbox failure diagnostics were unavailable; continuing rollback."),
      order,
      rollbackCalls: patch.rollbackManagedStartupAfterCreateFailure.mock.calls.length,
      sandboxDeletedByName: vi.mocked(deps.runOpenshell).mock.calls.some(
        ([args]) => args.join(" ") === "sandbox delete alpha",
      ),
    }).toEqual({
      diagnosticCall: [
        "alpha",
        { backupPath: null, gatewayPort: 8080, sandboxId: "alpha-sandbox-id" },
      ],
      diagnosticUnavailable: true,
      order: ["diagnostics", "rollback"],
      rollbackCalls: 1,
      sandboxDeletedByName: false,
    });
  });

  it("preserves the readiness failure when rollback rejects (#10412)", async () => {
    const deps = createDeps();
    const patch = createGpuPatchFixture();
    patch.rollbackManagedStartupAfterCreateFailure.mockRejectedValue(
      new Error("rollback unavailable"),
    );
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get -g nemoclaw alpha", [readySandboxGetResult()]],
        [
          "sandbox exec -g nemoclaw --name alpha -- true",
          [{ status: 1, stdout: "", stderr: "permission denied" }],
        ],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "  Sandbox failure rollback did not complete: rollback unavailable",
    );
  });

  it("saves verified readiness evidence before rollback (#10412)", async () => {
    const homeDir = makeTempDir("nemoclaw-readiness-diagnostics-");
    const sandboxId = "alpha-sandbox-id";
    const replacementId = "replacement-sandbox-id";
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const stateDir = path.join(logDir, "vm-driver", "sandboxes", sandboxId);
    const consolePath = path.join(stateDir, "rootfs-console.log");
    const bundleRoot = path.join(homeDir, ".nemoclaw", "onboard-failures");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(consolePath, "verified console failure\n");
    fs.writeFileSync(
      path.join(logDir, "openshell-gateway.log"),
      [
        `create_sandbox received sandbox_id=${sandboxId} sandbox_name=alpha`,
        `sandbox_id=${sandboxId} state_dir=${stateDir} console_output=${consolePath}`,
        `ERROR krun sandbox_id=${sandboxId} reason=ProcessExited`,
        `create_sandbox received sandbox_id=${replacementId} sandbox_name=alpha`,
        `ERROR krun sandbox_id=${replacementId} reason=replacement-failure`,
      ].join("\n"),
    );
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const actualDiagnostics = await vi.importActual<
      typeof import("./sandbox-create-failure")
    >("./sandbox-create-failure");
    mocks.printSandboxCreateFailureDiagnostics.mockImplementation(
      actualDiagnostics.printSandboxCreateFailureDiagnostics,
    );
    const patch = createGpuPatchFixture();
    let bundleExistedBeforeRollback = false;
    patch.rollbackManagedStartupAfterCreateFailure.mockImplementation(() => {
      const bundleName = fs.readdirSync(bundleRoot)[0];
      bundleExistedBeforeRollback = Boolean(
        bundleName &&
        fs.existsSync(path.join(bundleRoot, bundleName, "openshell-gateway-relevant.log")),
      );
    });
    mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get -g nemoclaw alpha", [readySandboxGetResult()]],
        [
          "sandbox exec -g nemoclaw --name alpha -- true",
          [{ status: 1, stdout: "", stderr: "permission denied" }],
        ],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    const bundlePath = path.join(bundleRoot, fs.readdirSync(bundleRoot)[0]!);
    const gatewayEvidence = fs.readFileSync(
      path.join(bundlePath, "openshell-gateway-relevant.log"),
      "utf8",
    );
    const consoleEvidence = fs.readFileSync(path.join(bundlePath, "rootfs-console.log"), "utf8");
    expect({
      bundleExistedBeforeRollback,
      consoleEvidence,
      gatewayHasReplacement: gatewayEvidence.includes(replacementId),
      gatewayHasVerifiedId: gatewayEvidence.includes(sandboxId),
      rollbackCalls: patch.rollbackManagedStartupAfterCreateFailure.mock.calls.length,
    }).toEqual({
      bundleExistedBeforeRollback: true,
      consoleEvidence: "verified console failure\n",
      gatewayHasReplacement: false,
      gatewayHasVerifiedId: true,
      rollbackCalls: 1,
    });
  });

  it("preserves a fresh sandbox when sandbox get omits a durable ID (#9050)", async () => {
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        [
          "sandbox get -g nemoclaw alpha",
          [{ status: 0, stdout: "Name: alpha\nState: Ready\n", stderr: "" }],
        ],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "exec", "-g", "nemoclaw", "--name", "alpha", "--", "true"],
      expect.anything(),
    );
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(console.error).toHaveBeenCalledWith(
      "  NemoClaw could not verify that sandbox 'alpha' returned a durable ID and accepted commands.",
    );
    expect(mocks.printSandboxCreateFailureDiagnostics).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "  Sandbox failure diagnostics were not collected because no durable sandbox identity was verified.",
    );
  });

  it("fails when the identity probe times out after emitting not-ready output (#9050)", async () => {
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get -g nemoclaw alpha", [timedOutOpenShellResult(SANDBOX_NOT_READY_OUTPUT)]],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "exec", "-g", "nemoclaw", "--name", "alpha", "--", "true"],
      expect.anything(),
    );
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("fails when the executable probe times out after emitting not-ready output (#9050)", async () => {
    const deps = createDeps();
    const input = createInput();
    input.sandboxReadyTimeoutSecs = 0.5;
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get -g nemoclaw alpha", [readySandboxGetResult()]],
        [
          ["sandbox", "exec", "-g", "nemoclaw", "--name", "alpha", "--", "true"].join(" "),
          [timedOutOpenShellResult(SANDBOX_NOT_READY_OUTPUT)],
        ],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    const identityOptions = vi
      .mocked(deps.runOpenshell)
      .mock.calls.find(([args]) => args.join(" ") === "sandbox get -g nemoclaw alpha")?.[1];
    const executableOptions = vi
      .mocked(deps.runOpenshell)
      .mock.calls.find(
        ([args]) => args.join(" ") === "sandbox exec -g nemoclaw --name alpha -- true",
      )?.[1];
    expect(identityOptions).toMatchObject({ killSignal: "SIGKILL" });
    expect(executableOptions).toMatchObject({ killSignal: "SIGKILL" });
    expect(identityOptions?.timeout).toBeGreaterThan(0);
    expect(identityOptions?.timeout).toBeLessThanOrEqual(500);
    expect(executableOptions?.timeout).toBeGreaterThan(0);
    expect(executableOptions?.timeout).toBeLessThanOrEqual(500);
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(mocks.printSandboxCreateFailureDiagnostics).toHaveBeenCalledWith("alpha", {
      backupPath: null,
      gatewayPort: 8080,
      sandboxId: "alpha-sandbox-id",
    });
  });
});
