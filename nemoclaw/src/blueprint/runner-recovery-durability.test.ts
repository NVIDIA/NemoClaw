// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRunnerFsStore,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  createInferenceRouteResult,
  createRunnerCommandResult,
  minimalBlueprint,
  successResult,
} from "./runner-test-fixtures.js";

const { store } = createRunnerFsStore();
const mockExeca = vi.fn();
const mockCloseSync = vi.hoisted(() => vi.fn());
const mockFsyncSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockOpenSync = vi.hoisted(() => vi.fn());
const mockRenameSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", () => ({ randomUUID: () => FIXED_RUN_UUID }));
vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  mockCloseSync.mockImplementation(memory.closeSync);
  mockFsyncSync.mockImplementation(memory.fsyncSync);
  mockMkdirSync.mockImplementation(memory.mkdirSync);
  mockOpenSync.mockImplementation(memory.openSync);
  mockRenameSync.mockImplementation(memory.renameSync);
  mockUnlinkSync.mockImplementation(memory.unlinkSync);
  mockWriteFileSync.mockImplementation(memory.writeFileSync);
  return {
    ...original,
    closeSync: mockCloseSync,
    fsyncSync: mockFsyncSync,
    mkdirSync: mockMkdirSync,
    openSync: mockOpenSync,
    readFileSync: memory.readFileSync,
    readdirSync: memory.readdirSync,
    renameSync: mockRenameSync,
    unlinkSync: mockUnlinkSync,
    writeFileSync: mockWriteFileSync,
  };
});
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));
vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    validateEndpointUrl: vi.fn(async (url: string) => resolvedEndpointFor(url)),
  };
});

const { actionApply, actionRollback } = await import("./runner.js");
const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

function planPath(): string {
  return [...store.keys()].find((path) => path.endsWith("/plan.json")) ?? "";
}

function commandNames(): string[] {
  return mockExeca.mock.calls.map(([, args]) => (args as string[]).join(" "));
}

function seedOwnedProviderRun(runId: string): string {
  const stateDir = `${RUNS_DIR}/${runId}`;
  store.set(stateDir, { type: "dir" });
  store.set(`${stateDir}/plan.json`, {
    type: "file",
    content: JSON.stringify({
      sandbox_name: "existing-sandbox",
      inference_provider_created_by_apply: true,
      provider_gateway: "test-gateway",
      inference: { provider_name: "my-provider" },
    }),
  });
  return stateDir;
}

describe("blueprint recovery durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const commandResult = createRunnerCommandResult();
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      commandResult(args, successResult()),
    );
  });

  it("flushes every newly created run-directory parent before external mutation (#9833)", async () => {
    mockMkdirSync.mockImplementationOnce((path: string) => {
      store.set(path, { type: "dir" });
      return `${FAKE_HOME}/.nemoclaw`;
    });

    await actionApply("default", minimalBlueprint());

    expect(mockOpenSync.mock.calls.slice(0, 4).map(([path]) => path)).toEqual([
      FAKE_HOME,
      `${FAKE_HOME}/.nemoclaw`,
      `${FAKE_HOME}/.nemoclaw/state`,
      RUNS_DIR,
    ]);
    const sandboxCreate = mockExeca.mock.calls.findIndex(
      ([, args]) => (args as string[]).slice(0, 2).join(" ") === "sandbox create",
    );
    expect(mockFsyncSync.mock.invocationCallOrder[3]).toBeLessThan(
      mockExeca.mock.invocationCallOrder[sandboxCreate]!,
    );
    expect(mockFsyncSync.mock.invocationCallOrder[3]).toBeLessThan(
      mockWriteFileSync.mock.invocationCallOrder[0]!,
    );
  });

  it("restores a mutate-then-interrupt route from its exact pre-mutation receipt (#9833)", async () => {
    const routeResult = createInferenceRouteResult("test-gateway");
    const commandResult = createRunnerCommandResult();
    let receiptAtMutation: unknown;
    const interceptors = new Map<
      string,
      Array<(args: string[]) => ReturnType<typeof successResult>>
    >([
      [
        "inference set -g test-gateway --provider my-provider --model gpt-4",
        [
          (args) => {
            routeResult(args, successResult());
            receiptAtMutation = JSON.parse(
              store.get(planPath())?.content ?? "{}",
            ).inference_route_recovery;
            interceptors.set("inference get -g test-gateway", [
              () => ({ exitCode: 1, stdout: "", stderr: "gateway interrupted" }),
            ]);
            throw new Error("transport interrupted after route mutation");
          },
        ],
      ],
    ]);
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      const command = args.join(" ");
      return (
        interceptors.get(command)?.shift()?.(args) ??
        routeResult(args, commandResult(args, successResult()))
      );
    });

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /transport interrupted after route mutation/u,
    );

    expect(receiptAtMutation).toEqual({
      gateway: "test-gateway",
      previous_route: {
        state: "configured",
        provider: "prior-provider",
        model: "prior-model",
        timeout_seconds: 45,
      },
      replacement_route: {
        state: "configured",
        provider: "my-provider",
        model: "gpt-4",
        timeout_seconds: 180,
      },
    });
    expect(commandNames()).not.toContain("provider delete -g test-gateway my-provider");
    const retainedPlan = JSON.parse(store.get(planPath())?.content ?? "{}");

    mockExeca.mockClear();
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      routeResult(args, commandResult(args, successResult())),
    );
    await actionRollback(retainedPlan.run_id);

    const commands = commandNames();
    const restore =
      "inference set -g test-gateway --provider prior-provider --model prior-model --timeout 45";
    expect(commands).toContain(restore);
    expect(commands.indexOf(restore)).toBeLessThan(
      commands.indexOf("provider delete -g test-gateway my-provider"),
    );
  });

  it("atomically consumes completed rollback so replay cannot touch newer names (#9833)", async () => {
    const stateDir = seedOwnedProviderRun("completed-rollback");

    await actionRollback("completed-rollback");
    const markerPath = `${stateDir}/rolled_back`;
    expect(JSON.parse(store.get(markerPath)?.content ?? "{}")).toEqual({
      state: "rolled_back",
      completed_at: expect.any(String),
    });
    expect(mockRenameSync).toHaveBeenCalledWith(
      `${markerPath}.${String(process.pid)}.tmp`,
      markerPath,
    );

    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "newer-sandbox",
        sandbox_created_by_apply: true,
        provider_gateway: "test-gateway",
      }),
    });
    mockExeca.mockClear();
    await actionRollback("completed-rollback");
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("re-syncs a visible rollback marker after its first parent flush failed (#9833)", async () => {
    const stateDir = seedOwnedProviderRun("marker-flush-retry");
    mockFsyncSync
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("rollback marker parent sync denied");
      });

    await expect(actionRollback("marker-flush-retry")).rejects.toThrow(
      /rollback marker parent sync denied/u,
    );
    expect(store.has(`${stateDir}/rolled_back`)).toBe(true);
    expect(commandNames()).toContain("provider delete -g test-gateway my-provider");

    mockExeca.mockClear();
    mockOpenSync.mockClear();
    mockFsyncSync.mockClear();
    await actionRollback("marker-flush-retry");
    expect(mockOpenSync).toHaveBeenCalledWith(stateDir, "r");
    expect(mockFsyncSync).toHaveBeenCalledTimes(1);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("leaves an interrupted rollback unconsumed and retryable (#9833)", async () => {
    const stateDir = seedOwnedProviderRun("interrupted-rollback");
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" });

    await expect(actionRollback("interrupted-rollback")).rejects.toThrow(/denied/u);
    expect(store.has(`${stateDir}/rolled_back`)).toBe(false);

    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await actionRollback("interrupted-rollback");
    expect(
      commandNames().filter((command) => command === "provider delete -g test-gateway my-provider"),
    ).toHaveLength(2);
    expect(store.has(`${stateDir}/rolled_back`)).toBe(true);
  });
});
