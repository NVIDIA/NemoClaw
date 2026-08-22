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
  sandboxPolicyAuthorityResult,
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

const { BlueprintPolicyAuthorityRefusalError } = await import("./runtime-identity.js");
const { actionApply, actionRollback, actionStatus } = await import("./runner.js");
const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

function planPath(): string {
  return [...store.keys()].find((path) => path.endsWith("/plan.json")) ?? "";
}

function commandNames(): string[] {
  return mockExeca.mock.calls.map(([, args]) => (args as string[]).join(" "));
}

function seedRun(runId: string, plan: Record<string, unknown>): string {
  const stateDir = `${RUNS_DIR}/${runId}`;
  store.set(stateDir, { type: "dir" });
  store.set(`${stateDir}/plan.json`, {
    type: "file",
    content: JSON.stringify(plan),
  });
  return stateDir;
}

function seedOwnedProviderRun(runId: string): string {
  return seedRun(runId, {
    sandbox_name: "existing-sandbox",
    inference_provider_created_by_apply: true,
    provider_gateway: "test-gateway",
    inference: { provider_name: "my-provider" },
  });
}

async function expectApplyCleanupFailure(
  failedCommand: string,
  failure: () => ReturnType<typeof successResult>,
  expected: RegExp,
): Promise<void> {
  const routeResult = createInferenceRouteResult("test-gateway");
  const commandResult = createRunnerCommandResult();
  let routeSet = false;
  mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
    const command = args.join(" ");
    const exactResult = new Map([
      [failedCommand, failure],
      [
        "policy get -g test-gateway --full --output json test-sandbox",
        () =>
          sandboxPolicyAuthorityResult(
            "test-sandbox",
            routeSet ? "externally-managed" : "nemoclaw-managed",
          ),
      ],
    ]).get(command);
    const result = exactResult?.() ?? routeResult(args, commandResult(args, successResult()));
    new Map([
      [
        "inference set -g test-gateway --provider my-provider --model gpt-4 --timeout 180",
        () => {
          routeSet = true;
        },
      ],
    ]).get(command)?.();
    return result;
  });

  await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(expected);
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
        "inference set -g test-gateway --provider my-provider --model gpt-4 --timeout 180",
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

  it.each([
    [
      "a legacy destructive ownership receipt",
      { sandbox_created_by_apply: true },
      /provider gateway receipt is required for destructive rollback/u,
    ],
    [
      "a malformed configured-route receipt",
      {
        provider_gateway: "test-gateway",
        inference_route_recovery: {
          gateway: "test-gateway",
          previous_route: {
            state: "configured",
            provider: "prior-provider",
            model: "prior-model",
          },
          replacement_route: {
            state: "configured",
            provider: "my-provider",
            model: "gpt-4",
            timeout_seconds: 180,
          },
        },
      },
      /inference route recovery receipt is invalid/u,
    ],
    [
      "an invalid policy authority receipt",
      { policy_authority: { authority: "invalid", scope: "global" } },
      /policy authority receipt is invalid/u,
    ],
    [
      "a policy authority receipt for another sandbox",
      {
        policy_authority: {
          authority: "nemoclaw-managed",
          scope: "sandbox",
          sandbox_name: "other-sandbox",
        },
      },
      /policy authority receipt names another sandbox/u,
    ],
    [
      "an invalid provider gateway receipt",
      { sandbox_created_by_apply: true, provider_gateway: "../gateway" },
      /provider gateway receipt is invalid/u,
    ],
    [
      "a provider gateway conflicting with route recovery",
      {
        provider_gateway: "other-gateway",
        inference_route_recovery: {
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
        },
      },
      /provider gateway receipt conflicts with route recovery receipt/u,
    ],
    [
      "an invalid owned provider receipt",
      {
        inference_provider_created_by_apply: true,
        provider_gateway: "test-gateway",
        inference: { provider_name: "../../other" },
      },
      /Invalid rollback inference provider name/u,
    ],
  ])("rejects %s before rollback mutation (#9833)", async (_case, plan, expectedError) => {
    const runId = "invalid-recovery-receipt";
    const stateDir = seedRun(runId, { sandbox_name: "existing-sandbox", ...plan });

    await expect(actionRollback(runId)).rejects.toThrow(expectedError);
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.has(`${stateDir}/rolled_back`)).toBe(false);
  });

  it("preserves the refusal and continues cleanup when clearing a route receipt cannot persist (#9833)", async () => {
    const routeResult = createInferenceRouteResult("test-gateway", null);
    const commandResult = createRunnerCommandResult();
    let replacementSet = false;
    const providerCreateCommand =
      "provider create -g test-gateway --name my-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1";
    const policyGetCommand = "policy get -g test-gateway --full --output json test-sandbox";
    const inferenceSetCommand =
      "inference set -g test-gateway --provider my-provider --model gpt-4 --timeout 180";
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
      const command = args.join(" ");
      const exactResult = new Map([
        [providerCreateCommand, () => ({ exitCode: 1, stdout: "", stderr: "already exists" })],
        [
          policyGetCommand,
          () =>
            sandboxPolicyAuthorityResult(
              "test-sandbox",
              replacementSet ? "externally-managed" : "nemoclaw-managed",
            ),
        ],
      ]).get(command);
      const result = exactResult?.() ?? routeResult(args, commandResult(args, successResult()));
      new Map([
        [
          inferenceSetCommand,
          () => {
            replacementSet = true;
            mockWriteFileSync.mockImplementationOnce(() => {
              throw new Error("API_TOKEN=receipt-secret receipt clear denied");
            });
          },
        ],
      ]).get(command)?.();
      return result;
    });

    const error = await actionApply("default", minimalBlueprint()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    const message = (error as Error).message;
    expect(message).toMatch(
      /authority changed[\s\S]*cleanup failed[\s\S]*Failed to persist cleared inference route recovery receipt/u,
    );
    expect(message).toContain("API_TOKEN=<REDACTED>");
    expect(message).not.toContain("receipt-secret");
    expect(commandNames()).toContain("sandbox stop -g test-gateway test-sandbox");
    expect(commandNames()).toContain("sandbox remove -g test-gateway test-sandbox");
    expect(commandNames()).toContain("inference delete -g test-gateway");
    expect(commandNames()).not.toContain("provider delete -g test-gateway my-provider");
    const plan = JSON.parse(store.get(planPath())?.content ?? "{}");
    expect(plan).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: false,
    });
    expect(plan).not.toHaveProperty("inference_route_recovery");
  });

  it.each([
    {
      name: "an unreadable active gateway",
      exercise: async () => {
        const commandResult = createRunnerCommandResult();
        mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
          args.join(" ") === "status"
            ? { exitCode: 1, stdout: "", stderr: "status denied" }
            : commandResult(args, successResult()),
        );
        await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
          /Failed to inspect the active OpenShell gateway/u,
        );
      },
    },
    {
      name: "an ambiguous active gateway",
      exercise: async () => {
        const commandResult = createRunnerCommandResult();
        mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
          args.join(" ") === "status" ? successResult() : commandResult(args, successResult()),
        );
        await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
          /Failed to prove the active OpenShell gateway identity/u,
        );
      },
    },
    {
      name: "a configured route without a timeout",
      exercise: async () => {
        const commandResult = createRunnerCommandResult();
        mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
          args.join(" ") === "inference get -g test-gateway"
            ? {
                exitCode: 0,
                stdout: "Gateway inference:\n  Provider: prior-provider\n  Model: prior-model\n",
                stderr: "",
              }
            : commandResult(args, successResult()),
        );
        await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
          /prior timeout is not a finite integer/u,
        );
      },
    },
    {
      name: "an unparseable route",
      exercise: async () => {
        const commandResult = createRunnerCommandResult();
        mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
          args.join(" ") === "inference get -g test-gateway"
            ? { exitCode: 0, stdout: "unknown route", stderr: "" }
            : commandResult(args, successResult()),
        );
        await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
          /Failed to parse the active inference route/u,
        );
      },
    },
    {
      name: "a non-object status plan",
      exercise: async () => {
        const stateDir = `${RUNS_DIR}/invalid-status-plan`;
        store.set(stateDir, { type: "dir" });
        store.set(`${stateDir}/plan.json`, { type: "file", content: "[]" });
        actionStatus("invalid-status-plan");
        expect(vi.mocked(process.stdout.write).mock.calls.flat().join("")).toContain(
          '"status":"unknown"',
        );
      },
    },
    {
      name: "validated route and global-authority status receipts",
      exercise: async () => {
        seedRun("validated-status-plan", {
          run_id: "validated-status-plan",
          sandbox_name: "existing-sandbox",
          policy_authority: { authority: "nemoclaw-managed", scope: "global" },
          inference_route_recovery: {
            gateway: "test-gateway",
            previous_route: { state: "unconfigured" },
            replacement_route: {
              state: "configured",
              provider: "my-provider",
              model: "gpt-4",
              timeout_seconds: 180,
            },
          },
        });
        actionStatus("validated-status-plan");
        const output = vi.mocked(process.stdout.write).mock.calls.flat().join("");
        expect(output).toContain('"inference_route_recovery"');
        expect(output).toContain('"policy_authority"');
      },
    },
    {
      name: "a denied sandbox removal",
      exercise: () =>
        expectApplyCleanupFailure(
          "sandbox remove -g test-gateway test-sandbox",
          () => ({ exitCode: 1, stdout: "", stderr: "sandbox remove denied" }),
          /cleanup failed.*sandbox remove denied/su,
        ),
    },
    {
      name: "a sandbox removal spawn failure",
      exercise: () =>
        expectApplyCleanupFailure(
          "sandbox remove -g test-gateway test-sandbox",
          () => {
            throw new Error("sandbox remove spawn failed");
          },
          /cleanup failed.*sandbox remove spawn failed/su,
        ),
    },
    {
      name: "a denied provider deletion",
      exercise: () =>
        expectApplyCleanupFailure(
          "provider delete -g test-gateway my-provider",
          () => ({ exitCode: 1, stdout: "", stderr: "provider delete denied" }),
          /cleanup failed.*provider delete denied/su,
        ),
    },
    {
      name: "a provider deletion spawn failure",
      exercise: () =>
        expectApplyCleanupFailure(
          "provider delete -g test-gateway my-provider",
          () => {
            throw new Error("provider delete spawn failed");
          },
          /cleanup failed.*provider delete spawn failed/su,
        ),
    },
  ])("retains deterministic recovery semantics for $name (#9833)", async ({ exercise }) => {
    await exercise();
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
});
