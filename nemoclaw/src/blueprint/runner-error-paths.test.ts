// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  createRunnerFsStore,
  createStdoutCapture,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  minimalBlueprint,
  resultWithBlueprintPolicy,
  TEST_SANDBOX_POLICY,
  TEST_SANDBOX_POLICY_PATH,
} from "./runner-test-fixtures.js";

const { store, addFile, addDir } = createRunnerFsStore();
const mockExeca = vi.fn();

vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => FIXED_RUN_UUID,
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  return {
    ...original,
    existsSync: memory.existsSync,
    closeSync: memory.closeSync,
    fsyncSync: memory.fsyncSync,
    mkdirSync: memory.mkdirSync,
    openSync: memory.openSync,
    readFileSync: memory.readFileSync,
    renameSync: memory.renameSync,
    unlinkSync: memory.unlinkSync,
    writeFileSync: memory.writeFileSync,
    readdirSync: memory.readdirSync,
  };
});
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));
vi.mock("./ssrf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssrf.js")>()),
  validateEndpointUrl: vi.fn(async (url: string) => resolvedEndpointFor(url)),
}));

const { actionApply, actionReconcile, actionStatus, loadBlueprint, main } =
  await import("./runner.js");
const stdoutCapture = createStdoutCapture();

function captureStdout(): void {
  vi.spyOn(process.stdout, "write").mockImplementation(stdoutCapture.write);
}

describe("runner error paths", () => {
  beforeEach(() => {
    store.clear();
    addFile(TEST_SANDBOX_POLICY_PATH, TEST_SANDBOX_POLICY);
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", TEST_SANDBOX_POLICY_PATH);
    stdoutCapture.reset();
    vi.clearAllMocks();
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      resultWithBlueprintPolicy(args, { exitCode: 0, stdout: "", stderr: "" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ["sandbox", { components: { sandbox: "invalid" } }],
    ["router", { components: { router: "invalid" } }],
    ["policy", { components: { policy: "invalid" } }],
    ["policy additions", { components: { policy: { additions: [] } } }],
  ])("rejects an invalid %s component shape", (_name, blueprint) => {
    addFile("blueprint.yaml", YAML.stringify(blueprint));
    expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
  });

  it.each([
    [
      "a failed status command",
      { exitCode: 1, stdout: "", stderr: "gateway unavailable" },
      /Failed to inspect the active OpenShell gateway/,
    ],
    [
      "an ambiguous active gateway",
      { exitCode: 0, stdout: "Status: Disconnected\n", stderr: "" },
      /Failed to prove the active OpenShell gateway identity/,
    ],
  ])("fails before mutation for %s", async (_name, statusResult, expected) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "status"
        ? statusResult
        : resultWithBlueprintPolicy(args, { exitCode: 0, stdout: "", stderr: "" }),
    );

    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(expected);
    expect(mockExeca.mock.calls.some(([, args]) => args?.[0] === "sandbox")).toBe(false);
  });

  it("lets OpenShell decide creation when no sandbox policy is configured", async () => {
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", "  ");

    await expect(actionApply("default", minimalBlueprint())).resolves.toBeUndefined();
    const create = mockExeca.mock.calls.find(
      ([, args]) => args?.[0] === "sandbox" && args?.[1] === "create",
    );
    expect(create).toBeDefined();
    expect(create?.[1]).not.toContain("--policy");
  });

  it("rejects an unreadable configured sandbox policy", async () => {
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", "/missing-policy.yaml");
    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /configured NemoClaw sandbox policy could not be read/,
    );
  });

  it("rejects an invalid configured sandbox policy", async () => {
    addFile("/invalid-policy.yaml", "version: [unterminated");
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", "/invalid-policy.yaml");
    await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
      /configured NemoClaw sandbox policy is invalid/,
    );
  });

  it("prints unknown status when the gateway binding is invalid", () => {
    const rid = "nc-run-invalid";
    const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/${rid}`;
    addDir(runDir);
    addFile(`${runDir}/plan.json`, JSON.stringify({ run_id: rid, gateway: "wrong" }));
    captureStdout();

    actionStatus(rid);

    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: rid,
      status: "unknown",
      receipt_error_kind: "invalid",
    });
  });

  it("rejects a missing reconciliation run", async () => {
    await expect(actionReconcile("nc-missing")).rejects.toThrow(/nc-missing not found/);
  });

  it.each([
    ["non-object plan", "[]", /JSON object/],
    [
      "invalid gateway",
      JSON.stringify({ sandbox_name: "sb", gateway: "wrong" }),
      /gateway binding is invalid/,
    ],
  ])("rejects a reconciliation receipt with %s", async (_name, contents, expected) => {
    const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/nc-invalid`;
    addDir(runDir);
    addFile(`${runDir}/plan.json`, contents);

    await expect(actionReconcile("nc-invalid")).rejects.toThrow(expected);
  });

  it("reports OpenShell policy ownership without a policy mutation", async () => {
    const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/nc-empty`;
    addDir(runDir);
    addFile(
      `${runDir}/plan.json`,
      JSON.stringify({
        sandbox_name: "sb",
        gateway: { name: "test-gateway", host: "127.0.0.1", port: 8080 },
      }),
    );
    captureStdout();

    await actionReconcile("nc-empty");

    expect(stdoutCapture.text()).toContain("policy is managed directly by OpenShell");
    expect(mockExeca.mock.calls.some(([, args]) => args?.[0] === "policy")).toBe(false);
  });

  it("rejects a gateway binding that changed after the run", async () => {
    const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/nc-drifted`;
    addDir(runDir);
    addFile(
      `${runDir}/plan.json`,
      JSON.stringify({
        sandbox_name: "sb",
        gateway: { name: "test-gateway", host: "127.0.0.1", port: 8080 },
      }),
    );
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.join(" ") === "gateway info -g test-gateway"
        ? { exitCode: 0, stdout: "Gateway endpoint: http://127.0.0.1:9090\n", stderr: "" }
        : resultWithBlueprintPolicy(args, { exitCode: 0, stdout: "", stderr: "" }),
    );

    await expect(actionReconcile("nc-drifted")).rejects.toThrow(/gateway binding changed/);
  });

  it("throws when reconcile has no --run-id", async () => {
    await expect(main(["reconcile"])).rejects.toThrow(/--run-id is required for reconcile/);
  });

  it.each(["--profile", "--plan", "--run-id", "--endpoint-url"])(
    "rejects a missing value for %s",
    async (flag) => {
      await expect(main(["plan", flag])).rejects.toThrow(`${flag} requires a value`);
    },
  );
});
