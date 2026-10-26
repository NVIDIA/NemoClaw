// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeManagedStateVolumes } from "../../../src/lib/onboard/managed-workload/managed-state-volumes";
import {
  cleanupInterruptedManagedImageOpenShellE2e,
  createManagedImageSandboxWithRecovery,
  prepareManagedImageOpenShellState,
} from "../../../scripts/checks/run-managed-image-openshell-e2e";
import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../../../src/lib/adapters/openshell/sandbox-identity";

const mocks = vi.hoisted(() => ({
  stopGateway: vi.fn(),
  removeVolumes: vi.fn(),
  roots: vi.fn(),
  capture: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../../../src/lib/onboard/host-gateway-process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/onboard/host-gateway-process")>()),
  stopHostGatewayProcesses: mocks.stopGateway,
}));
vi.mock("../../../src/lib/onboard.ts", () => ({
  default: {
    openshellArgv: (args: string[]) => ["openshell", ...args],
    runOpenshell: mocks.run,
    runCaptureOpenshell: mocks.capture,
    sleepSeconds: vi.fn(),
    startGatewayForRecovery: vi.fn(),
    createForwardPortObserver: vi.fn(),
    managedWorkloadOnboard: {
      completeProviderManagedStartup: vi.fn(),
      managedStartupStateRoots: mocks.roots,
      managedStartupWorkspaceRoot: vi.fn(),
      prepareManagedStateVolumes: vi.fn(),
      removeManagedStateVolumes: mocks.removeVolumes,
    },
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

const realSpawnSync = childProcess.spawnSync;
const sandboxId = "owned-sandbox-id";
const createAttemptNonce = "c".repeat(62);
function sandboxObservation(id = sandboxId, nonce = createAttemptNonce): string {
  return JSON.stringify([
    {
      id,
      name: input.sandbox,
      labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
      resource_version: 1,
      created_at: "2026-10-14T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
    },
  ]);
}

const input = {
  agent: "openclaw" as const,
  image: `ghcr.io/nvidia/nemoclaw/openclaw@sha256:${"a".repeat(64)}`,
  sandbox: "spark-agent",
  localProvider: "llama-cpp" as const,
  model: "nvidia-nemotron-3-nano-30b-a3b",
};
let root: string;
let scope: { owner: string; stateDir: string; networkName: string };
let commands: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-recovery-"));
  const owner = "llama-cpp-dgx-spark-42-2";
  scope = {
    owner,
    stateDir: path.join(root, owner, "managed-openshell"),
    networkName: `nemoclaw-managed-${owner}`,
  };
  fs.mkdirSync(path.dirname(scope.stateDir), { mode: 0o700 });
  prepareManagedImageOpenShellState(input, scope);
  mocks.capture.mockReturnValue(sandboxObservation());
  mocks.run.mockReturnValue({
    status: 0,
    stdout: `ID: ${sandboxId}`,
    stderr: "",
  });
  const create = createManagedImageSandboxWithRecovery(
    input,
    scope,
    {
      runCaptureOpenshell: mocks.capture,
    },
    vi.fn().mockResolvedValue({ status: 0, output: "", ambiguous: false }),
  );
  await create({
    sandboxName: input.sandbox,
    target: { kind: "named", gatewayName: "nemoclaw" },
    source: { reference: input.image },
    startupCommand: ["true"],
    environment: process.env,
    labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: createAttemptNonce },
  });
  mocks.stopGateway.mockReturnValue({
    failed: [],
    ownershipFailures: [],
    stopped: [4242],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    sudoRemediationPids: [],
  });
  mocks.roots.mockReturnValue([
    {
      resourceIdentity: "owned-volume",
      ownershipLabels: { original: "expected" },
    },
  ]);
  mocks.removeVolumes.mockReturnValue([{ status: "removed" }]);
  commands = vi
    .spyOn(childProcess, "spawnSync")
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 0,
      stdout: `sha256:${"b".repeat(64)}`,
      stderr: "",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: "openshell 0.0.116", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `Error: No such network: ${scope.networkName}`,
    } as any);
  mocks.capture.mockImplementation((args: readonly string[]) =>
    args[0] === "--version"
      ? "openshell 0.0.116"
      : commands.mock.calls.some(
            ([command, args]: [string, readonly string[]]) =>
              command === "openshell" && args[0] === "sandbox" && args[1] === "delete",
          )
        ? "[]"
        : sandboxObservation(),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it("recovers only the marked isolated sandbox, gateway, volumes and network", async () => {
  const foreign = path.join(root, "foreign-state");
  fs.mkdirSync(foreign);
  const previous = { ...process.env };
  expect(
    JSON.parse(fs.readFileSync(path.join(scope.stateDir, "qualification-owner.json"), "utf8")),
  ).toEqual({ kind: "managed-qualification-owner-v2", input, scope });
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(
    commands.mock.calls.map(([command, args]: [string, readonly string[]]) => [command, ...args]),
  ).toEqual([
    ["openshell", "sandbox", "delete", "-g", "nemoclaw", input.sandbox],
    ["openshell", "gateway", "remove", "nemoclaw"],
    ["docker", "image", "inspect", "--format", "{{.Id}}", input.image],
    ["openshell", "--version"],
    [
      "docker",
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${input.sandbox}`,
    ],
    ["docker", "network", "rm", scope.networkName],
    ["docker", "network", "inspect", scope.networkName],
  ]);
  expect(mocks.stopGateway).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      stateDir: path.join(scope.stateDir, "gateway-state"),
      scopedGatewayStop: true,
      usePgrepFallback: false,
    }),
  );
  expect(mocks.removeVolumes).toHaveBeenCalledWith(
    {
      roots: [
        {
          resourceIdentity: "owned-volume",
          ownershipLabels: {
            original: "expected",
            "io.nvidia.nemoclaw.qualification-owner": scope.owner,
          },
        },
      ],
    },
    expect.anything(),
  );
  expect(fs.existsSync(scope.stateDir)).toBe(false);
  expect(fs.existsSync(foreign)).toBe(true);
  expect(process.env).toEqual(previous);
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(commands).toHaveBeenCalledTimes(7);
});

it.each([
  ["0.0.116", "--limit"],
  ["0.1.3", "--page-size"],
])("confirms strict absence with OpenShell %s before continuing cleanup", async (version, flag) => {
  mocks.capture
    .mockReset()
    .mockReturnValueOnce(sandboxObservation())
    .mockImplementationOnce((args) => {
      expect(commands).toHaveBeenCalledTimes(1);
      expect(args).toEqual(["--version"]);
      return `openshell ${version}`;
    })
    .mockReturnValueOnce("[]");
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(mocks.capture.mock.calls.slice(1)).toEqual([
    [["--version"], { ignoreError: false, timeout: 30000, maxBuffer: 1024 * 1024 }],
    [
      [
        "sandbox",
        "list",
        "-g",
        "nemoclaw",
        "--selector",
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${createAttemptNonce}`,
        "--output",
        "json",
        flag,
        "2",
      ],
      { ignoreError: false, timeout: 30000, maxBuffer: 1024 * 1024 },
    ],
  ]);
  expect(commands).toHaveBeenCalledTimes(7);
  expect(mocks.stopGateway).toHaveBeenCalledOnce();
  expect(mocks.removeVolumes).toHaveBeenCalledOnce();
  expect(fs.existsSync(scope.stateDir)).toBe(false);
});

it.each(["not-json", "{}", "null", sandboxObservation(), "[]\n[]"])(
  "preserves recovery evidence for rejected 0.1.3 absence response %s",
  async (response) => {
    mocks.capture
      .mockReset()
      .mockReturnValueOnce(sandboxObservation())
      .mockReturnValueOnce("openshell 0.1.3")
      .mockReturnValueOnce(response);
    await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
      "sandbox identity or deletion is unproven",
    );
    expect(mocks.capture.mock.calls.at(-1)?.[0]).toEqual([
      "sandbox",
      "list",
      "-g",
      "nemoclaw",
      "--selector",
      `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${createAttemptNonce}`,
      "--output",
      "json",
      "--page-size",
      "2",
    ]);
    expect(commands).toHaveBeenCalledTimes(1);
    expect(mocks.stopGateway).not.toHaveBeenCalled();
    expect(mocks.removeVolumes).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(scope.stateDir, "qualification-sandbox-deleted.json"))).toBe(
      false,
    );
    expect(fs.existsSync(scope.stateDir)).toBe(true);
  },
);

it.each(["foreign marker", "oversized marker"])(
  "rejects %s before any external mutation",
  async (reason) => {
    fs.writeFileSync(
      path.join(scope.stateDir, "qualification-owner.json"),
      reason === "foreign marker" ? "foreign-run" : "x".repeat(8193),
    );
    await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
      "identity mismatch",
    );
    expect(commands).not.toHaveBeenCalled();
    expect(mocks.stopGateway).not.toHaveBeenCalled();
    expect(fs.existsSync(scope.stateDir)).toBe(true);
  },
);

it.runIf(process.platform === "linux")(
  "rejects a symlink marker without touching its target",
  async () => {
    const marker = path.join(scope.stateDir, "qualification-owner.json");
    const target = path.join(root, "foreign-marker.json");
    fs.writeFileSync(target, "foreign-owner");
    fs.unlinkSync(marker);
    fs.symlinkSync(target, marker);
    await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(commands).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("foreign-owner");
  },
);

it.runIf(process.platform === "linux")("rejects a FIFO marker without waiting for a writer", () => {
  const marker = path.join(scope.stateDir, "qualification-owner.json");
  fs.unlinkSync(marker);
  expect(realSpawnSync("mkfifo", [marker]).status).toBe(0);
  const source = `require('./scripts/checks/run-managed-image-openshell-e2e.ts').cleanupInterruptedManagedImageOpenShellE2e(${JSON.stringify(input)}, ${JSON.stringify(scope)}).then(() => { process.exitCode = 1; }, error => { process.exitCode = error.message === 'managed recovery identity mismatch' ? 2 : 3; });`;
  const result = realSpawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "--eval", source],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: "", HOME: root },
      killSignal: "SIGKILL",
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(commands).not.toHaveBeenCalled();
});

it("preserves recovery evidence when gateway ownership cannot be proven", async () => {
  mocks.stopGateway.mockReturnValue({
    failed: [],
    ownershipFailures: ["foreign process"],
    stopped: [],
  });
  const previous = { ...process.env };
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "ownership or termination",
  );
  expect(commands).toHaveBeenCalledTimes(1);
  expect(mocks.removeVolumes).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(scope.stateDir, "qualification-owner.json"))).toBe(true);
  expect(process.env).toEqual(previous);
});

it("rejects ambiguous network inspection instead of deleting recovery state", async () => {
  commands
    .mockReset()
    .mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Docker network driver not found",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 0,
      stdout: `sha256:${"b".repeat(64)}`,
      stderr: "",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: "openshell 0.0.116", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any);
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "network cleanup is unproven",
  );
  expect(fs.existsSync(scope.stateDir)).toBe(true);
});

it("preserves state when the existing volume verifier rejects a foreign volume", async () => {
  const engine = vi.fn().mockReturnValue({
    status: 0,
    stdout: JSON.stringify({
      Name: "owned-volume",
      Labels: { original: "expected" },
    }),
    stderr: "",
  });
  mocks.removeVolumes.mockImplementation((value: Parameters<typeof removeManagedStateVolumes>[0]) =>
    removeManagedStateVolumes(value, { runContainerEngine: engine }),
  );
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "volume cleanup is unproven",
  );
  expect(engine).toHaveBeenCalledTimes(1);
  expect(engine).toHaveBeenCalledWith(
    ["inspect", "--format", "{{json .}}", "owned-volume"],
    expect.anything(),
  );
  expect(commands).toHaveBeenCalledTimes(5);
  expect(fs.existsSync(path.join(scope.stateDir, "qualification-owner.json"))).toBe(true);
});

it("accepts an exact bounded marker across short descriptor reads", async () => {
  const read = fs.readSync;
  const partialRead = vi
    .spyOn(fs, "readSync")
    .mockImplementation(((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => read(fd, buffer, offset, Math.min(length, 7), position)) as typeof fs.readSync);
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(partialRead.mock.calls.length).toBeGreaterThan(1);
  expect(fs.existsSync(scope.stateDir)).toBe(false);
});

it("retains recovery ownership when sandbox deletion fails", async () => {
  commands.mockReset().mockReturnValueOnce({ status: 1, stdout: "", stderr: "denied" } as any);
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "sandbox identity or deletion is unproven",
  );
  expect(commands).toHaveBeenCalledTimes(1);
  expect(mocks.stopGateway).not.toHaveBeenCalled();
  expect(mocks.removeVolumes).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(scope.stateDir, "qualification-owner.json"))).toBe(true);
});

it("continues cleanup after a post-deletion failure without deleting the sandbox again", async () => {
  mocks.roots.mockImplementationOnce(() => {
    throw new Error("injected post-deletion failure");
  });
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "injected post-deletion failure",
  );
  expect(fs.existsSync(path.join(scope.stateDir, "qualification-sandbox-deleted.json"))).toBe(true);
  commands
    .mockReset()
    .mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr:
        "Error:   × No gateway metadata found for 'nemoclaw'.\n  │ List available gateways: openshell gateway select",
    } as any)
    .mockReturnValueOnce({
      status: 0,
      stdout: `sha256:${"b".repeat(64)}`,
      stderr: "",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: "openshell 0.0.116", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `Error: No such network: ${scope.networkName}`,
    } as any);
  mocks.capture.mockClear();
  mocks.run.mockClear();
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(
    commands.mock.calls.map(([command, args]: [string, readonly string[]]) => [command, ...args]),
  ).toEqual([
    ["openshell", "gateway", "remove", "nemoclaw"],
    ["docker", "image", "inspect", "--format", "{{.Id}}", input.image],
    ["openshell", "--version"],
    [
      "docker",
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${input.sandbox}`,
    ],
    ["docker", "network", "rm", scope.networkName],
    ["docker", "network", "inspect", scope.networkName],
  ]);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(fs.existsSync(scope.stateDir)).toBe(false);
});

it("rejects a forged deletion marker before any external cleanup", async () => {
  fs.writeFileSync(
    path.join(scope.stateDir, "qualification-sandbox-deleted.json"),
    JSON.stringify({
      kind: "managed-qualification-sandbox-deleted-v1",
      owner: scope.owner,
      sandbox: input.sandbox,
      sandboxId: "foreign-id",
      createAttemptNonce,
    }),
  );
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "sandbox identity or deletion is unproven",
  );
  expect(commands).not.toHaveBeenCalled();
  expect(mocks.stopGateway).not.toHaveBeenCalled();
});

it("retains recovery state if absence cannot be confirmed after deletion", async () => {
  mocks.capture.mockReturnValue(sandboxObservation());
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "sandbox identity or deletion is unproven",
  );
  expect(commands).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(scope.stateDir, "qualification-sandbox-deleted.json"))).toBe(
    false,
  );
  expect(fs.existsSync(scope.stateDir)).toBe(true);
});

it("records the nonce-bound immutable identity from successful creation", () => {
  expect(
    JSON.parse(fs.readFileSync(path.join(scope.stateDir, "qualification-sandbox.json"), "utf8")),
  ).toEqual({
    kind: "managed-qualification-sandbox-v1",
    owner: scope.owner,
    sandbox: input.sandbox,
    sandboxId,
    createAttemptNonce,
  });
  expect(mocks.capture).toHaveBeenCalledWith(
    [
      "sandbox",
      "list",
      "-g",
      "nemoclaw",
      "--selector",
      `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${createAttemptNonce}`,
      "--output",
      "json",
      "--limit",
      "2",
    ],
    expect.objectContaining({ ignoreError: false, timeout: 30000 }),
  );
});

it("binds a generated create-attempt label and refuses a second create", async () => {
  fs.unlinkSync(path.join(scope.stateDir, "qualification-sandbox.json"));
  fs.unlinkSync(path.join(scope.stateDir, "qualification-attempt.json"));
  const delegate = vi.fn(
    async (request: Parameters<ReturnType<typeof createManagedImageSandboxWithRecovery>>[0]) => {
      expect(
        JSON.parse(
          fs.readFileSync(path.join(scope.stateDir, "qualification-attempt.json"), "utf8"),
        ),
      ).toEqual({
        kind: "managed-qualification-attempt-v1",
        owner: scope.owner,
        sandbox: input.sandbox,
        createAttemptNonce: request.labels![NEMOCLAW_CREATE_ATTEMPT_LABEL],
      });
      expect(fs.existsSync(path.join(scope.stateDir, "qualification-sandbox.json"))).toBe(false);
      mocks.capture.mockReturnValue(
        sandboxObservation(sandboxId, request.labels![NEMOCLAW_CREATE_ATTEMPT_LABEL]),
      );
      return {
        status: 0,
        output: "",
        sawProgress: false,
        ambiguous: false,
        diagnostic: "",
      };
    },
  );
  const create = createManagedImageSandboxWithRecovery(
    input,
    scope,
    {
      runCaptureOpenshell: mocks.capture,
    },
    delegate,
  );
  const request = {
    sandboxName: input.sandbox,
    target: { kind: "named" as const, gatewayName: "nemoclaw" },
    source: { reference: input.image },
    startupCommand: ["true"],
    environment: process.env,
  };
  await create(request);
  const submitted = delegate.mock.calls[0]![0];
  const nonce = submitted.labels![NEMOCLAW_CREATE_ATTEMPT_LABEL];
  expect(nonce).toMatch(/^[a-f0-9]{62}$/u);
  expect(
    JSON.parse(fs.readFileSync(path.join(scope.stateDir, "qualification-sandbox.json"), "utf8")),
  ).toMatchObject({ sandboxId, createAttemptNonce: nonce });
  await expect(create(request)).rejects.toThrow("create authority mismatch");
  expect(delegate).toHaveBeenCalledTimes(1);
});

it("does not delete a same-name sandbox with a different immutable identity", async () => {
  mocks.capture.mockReturnValue(sandboxObservation("foreign-sandbox-id"));
  mocks.run.mockReturnValue({
    status: 0,
    stdout: "ID: foreign-sandbox-id",
    stderr: "",
  });
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "inspection is required",
  );
  expect(commands).not.toHaveBeenCalled();
  expect(mocks.stopGateway).not.toHaveBeenCalled();
  expect(mocks.removeVolumes).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(scope.stateDir, "qualification-owner.json"))).toBe(true);
});

it("rejects replacement between the nonce selector and named inspection", async () => {
  mocks.run.mockReturnValue({
    status: 0,
    stdout: "ID: replacement-id",
    stderr: "",
  });
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "inspection is required",
  );
  expect(commands).not.toHaveBeenCalled();
  expect(fs.existsSync(scope.stateDir)).toBe(true);
});

it("recovers interrupted creation from its durable attempt nonce", async () => {
  fs.unlinkSync(path.join(scope.stateDir, "qualification-sandbox.json"));
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(commands.mock.calls[0]).toEqual([
    "openshell",
    ["sandbox", "delete", "-g", "nemoclaw", input.sandbox],
    expect.anything(),
  ]);
  expect(fs.existsSync(scope.stateDir)).toBe(false);
});

it("cleans setup before any create submission without issuing sandbox deletion", async () => {
  fs.unlinkSync(path.join(scope.stateDir, "qualification-sandbox.json"));
  fs.unlinkSync(path.join(scope.stateDir, "qualification-attempt.json"));
  commands.mockReset();
  commands
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 0,
      stdout: `sha256:${"b".repeat(64)}`,
      stderr: "",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: "openshell 0.0.116", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `Error: No such network: ${scope.networkName}`,
    } as any);
  mocks.capture.mockClear();
  mocks.run.mockClear();
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(commands).not.toHaveBeenCalledWith(
    "openshell",
    expect.arrayContaining(["sandbox", "delete"]),
    expect.anything(),
  );
  expect(commands.mock.calls[0]).toEqual([
    "openshell",
    ["gateway", "remove", "nemoclaw"],
    expect.anything(),
  ]);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(fs.existsSync(scope.stateDir)).toBe(false);
});

it("retains an unresolved create attempt rather than guessing identity", async () => {
  fs.unlinkSync(path.join(scope.stateDir, "qualification-sandbox.json"));
  mocks.capture.mockReturnValue("[]");
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "inspection is required",
  );
  expect(commands).not.toHaveBeenCalled();
  expect(fs.existsSync(scope.stateDir)).toBe(true);
});

it("preserves legacy owner records without inferring that creation never happened", async () => {
  fs.writeFileSync(
    path.join(scope.stateDir, "qualification-owner.json"),
    JSON.stringify({
      kind: "managed-qualification-owner-v1",
      input,
      scope,
    }),
  );
  await expect(cleanupInterruptedManagedImageOpenShellE2e(input, scope)).rejects.toThrow(
    "identity mismatch",
  );
  expect(commands).not.toHaveBeenCalled();
  expect(fs.existsSync(scope.stateDir)).toBe(true);
});

it("does not change unscoped managed creation", () => {
  const create = vi.fn();
  expect(
    createManagedImageSandboxWithRecovery(
      input,
      undefined,
      {
        runCaptureOpenshell: mocks.capture,
      },
      create,
    ),
  ).toBe(create);
});

it("cleans partial setup when no exact sandbox container was created", async () => {
  commands
    .mockReset()
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 0,
      stdout: `sha256:${"b".repeat(64)}`,
      stderr: "",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: "openshell 0.0.116", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `Error: No such network: ${scope.networkName}`,
    } as any);
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(fs.existsSync(scope.stateDir)).toBe(false);
  expect(commands).toHaveBeenCalledTimes(7);
});

it("removes the exact leftover container without removing a foreign container", async () => {
  const content = `sha256:${"b".repeat(64)}`;
  const owned = JSON.stringify([
    {
      Image: content,
      Config: {
        Labels: {
          "openshell.ai/managed-by": "openshell",
          "openshell.ai/sandbox-name": input.sandbox,
        },
      },
      NetworkSettings: { Networks: { [scope.networkName]: {} } },
    },
  ]);
  const foreign = JSON.stringify([
    {
      Image: content,
      Config: {
        Labels: {
          "openshell.ai/managed-by": "openshell",
          "openshell.ai/sandbox-name": input.sandbox,
        },
      },
      NetworkSettings: { Networks: { "foreign-network": {} } },
    },
  ]);
  commands
    .mockReset()
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: content, stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "openshell 0.0.116", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 0,
      stdout: "owned-container foreign-container",
      stderr: "",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: owned, stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: foreign, stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: content, stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "openshell 0.0.116", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 0,
      stdout: "foreign-container",
      stderr: "",
    } as any)
    .mockReturnValueOnce({ status: 0, stdout: foreign, stderr: "" } as any)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as any)
    .mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `Error: No such network: ${scope.networkName}`,
    } as any);
  await cleanupInterruptedManagedImageOpenShellE2e(input, scope);
  expect(commands).toHaveBeenCalledWith(
    "docker",
    ["rm", "--force", "owned-container"],
    expect.anything(),
  );
  expect(commands).not.toHaveBeenCalledWith(
    "docker",
    ["rm", "--force", "foreign-container"],
    expect.anything(),
  );
  expect(fs.existsSync(scope.stateDir)).toBe(false);
});
