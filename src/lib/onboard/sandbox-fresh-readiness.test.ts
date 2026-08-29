// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
afterEach(resetGpuFlowMocks);

describe("fresh sandbox executable readiness", () => {
  it("keeps a transient executable not-ready response inside the bounded wait (#9050)", async () => {
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get alpha", [readySandboxGetResult(), readySandboxGetResult()]],
        [
          "sandbox exec --name alpha -- true",
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
        .mock.calls.filter(([args]) => args.join(" ") === "sandbox exec --name alpha -- true"),
    ).toHaveLength(2);
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("fails when the executable readiness probe is terminal (#9050)", async () => {
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get alpha", [readySandboxGetResult()]],
        [
          "sandbox exec --name alpha -- true",
          [{ status: 1, stdout: "", stderr: "permission denied" }],
        ],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(mocks.printSandboxCreateFailureDiagnostics).toHaveBeenCalledWith("alpha", {
      backupPath: null,
    });
  });

  it("preserves a fresh sandbox when sandbox get omits a durable ID (#9050)", async () => {
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get alpha", [{ status: 0, stdout: "Name: alpha\nState: Ready\n", stderr: "" }]],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "true"],
      expect.anything(),
    );
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(console.error).toHaveBeenCalledWith(
      "  NemoClaw could not verify that sandbox 'alpha' returned a durable ID and accepted commands.",
    );
    expect(mocks.printSandboxCreateFailureDiagnostics).toHaveBeenCalledWith("alpha", {
      backupPath: null,
    });
  });

  it("fails when the identity probe times out after emitting not-ready output (#9050)", async () => {
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation(
      createSequencedOpenShellRunner([
        ["sandbox get alpha", [timedOutOpenShellResult(SANDBOX_NOT_READY_OUTPUT)]],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(createInput(), deps)).rejects.toThrow("process.exit:1");

    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "true"],
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
        ["sandbox get alpha", [readySandboxGetResult()]],
        [
          ["sandbox", "exec", "--name", "alpha", "--", "true"].join(" "),
          [timedOutOpenShellResult(SANDBOX_NOT_READY_OUTPUT)],
        ],
      ]),
    );
    mockExit();

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow("process.exit:1");

    const identityOptions = vi
      .mocked(deps.runOpenshell)
      .mock.calls.find(([args]) => args.join(" ") === "sandbox get alpha")?.[1];
    const executableOptions = vi
      .mocked(deps.runOpenshell)
      .mock.calls.find(([args]) => args.join(" ") === "sandbox exec --name alpha -- true")?.[1];
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
    });
  });
});
