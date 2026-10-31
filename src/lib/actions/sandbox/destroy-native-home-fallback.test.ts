// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("./mcp-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge")>()),
  prepareMcpBridgesForDestroy: async () => ({ entries: [] }),
}));

import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { DEEP_AGENTS_CODE_SANDBOX_USER } from "../../agent/deep-agents-code-runtime-identity";
import type { SandboxEntry } from "../../state/registry";
import { executeSandboxDestroy, wipeAgentNativeHome } from "./destroy-execution";

const unavailablePrivilegedExecutions = [
  {
    transport: "a returned command failure",
    execute: () => ({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("container is not running"),
    }),
  },
  {
    transport: "a thrown runtime refusal",
    execute: () => {
      throw new Error("container is not running");
    },
  },
];

describe("native-home destroy fallback", () => {
  it.each(
    [
      {
        initial: "owner permission failure",
        openshellResult: {
          status: 1,
          stdout: "",
          stderr: "rm: cannot remove root-owned managed state: Permission denied",
        },
      },
      {
        initial: "unavailable OpenShell execution",
        openshellResult: { status: 255, stdout: "", stderr: "sandbox is not running" },
      },
    ].flatMap((scenario) =>
      ["langchain-deepagents-code", "openclaw", "hermes"].map((agent) => ({ ...scenario, agent })),
    ),
  )(
    "completes $agent cleanup as the sandbox owner after $initial",
    ({ agent, openshellResult }) => {
      const runOpenshell = vi.fn(() => openshellResult);
      const runPrivileged = vi.fn((_command: readonly string[]) => ({
        status: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("rm: cannot remove sandbox-owned state: Permission denied"),
      }));
      const clearStoppedNativeHome = vi.fn(() => ({
        cleared: false as const,
        failure: "runtime-not-stopped" as const,
      }));
      const runAsSandboxUser = vi.fn(() => ({
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }));

      expect(() =>
        wipeAgentNativeHome(
          "alpha",
          agent,
          runOpenshell,
          undefined,
          runPrivileged,
          clearStoppedNativeHome,
          runAsSandboxUser,
        ),
      ).not.toThrow();
      expect(runOpenshell).toHaveBeenCalledOnce();
      expect(runPrivileged).toHaveBeenCalledOnce();
      expect(runAsSandboxUser).toHaveBeenCalledExactlyOnceWith(runPrivileged.mock.calls[0]![0]);
      expect(clearStoppedNativeHome).not.toHaveBeenCalled();
    },
  );

  it("retains the registry when no verified sandbox-user execution is available", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stdout: "", stderr: "permission denied" }));
    const runPrivileged = vi.fn(() => ({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("permission denied"),
    }));

    expect(() =>
      wipeAgentNativeHome(
        "alpha",
        "langchain-deepagents-code",
        runOpenshell,
        undefined,
        runPrivileged,
      ),
    ).toThrow("Could not remove the sandbox-owned LangChain Deep Agents Code native home");
    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runPrivileged).toHaveBeenCalledOnce();
  });

  it.each([
    { agent: "langchain-deepagents-code", label: "LangChain Deep Agents Code" },
    { agent: "openclaw", label: "OpenClaw" },
    { agent: "hermes", label: "Hermes Agent" },
  ])("fails closed when the pinned $agent user cannot finish the wipe", ({ agent, label }) => {
    const failure = { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const runAsSandboxUser = vi.fn(() => failure);

    expect(() =>
      wipeAgentNativeHome(
        "alpha",
        agent,
        () => ({ status: 1, stdout: "", stderr: "permission denied" }),
        undefined,
        () => failure,
        undefined,
        runAsSandboxUser,
      ),
    ).toThrow(`Could not remove the sandbox-owned ${label} native home`);
    expect(runAsSandboxUser).toHaveBeenCalledOnce();
  });

  it.each(unavailablePrivilegedExecutions)(
    "uses stopped-volume cleanup after $transport",
    ({ execute }) => {
      const runOpenshell = vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "sandbox is not running",
      }));
      const runPrivileged = vi.fn(execute);
      const clearStoppedNativeHome = vi.fn(() => ({ cleared: true as const }));

      expect(() =>
        wipeAgentNativeHome(
          "alpha",
          "openclaw",
          runOpenshell,
          undefined,
          runPrivileged,
          clearStoppedNativeHome,
        ),
      ).not.toThrow();
      expect(runPrivileged).toHaveBeenCalledOnce();
      expect(clearStoppedNativeHome).toHaveBeenCalledWith("/sandbox/.openclaw", []);
    },
  );

  it.each(unavailablePrivilegedExecutions)(
    "reports stopped cleanup failure after $transport",
    ({ execute }) => {
      const clearStoppedNativeHome = vi.fn(() => ({
        cleared: false as const,
        failure: "cleanup-helper-image-unavailable" as const,
      }));
      expect(() =>
        wipeAgentNativeHome(
          "alpha",
          "openclaw",
          () => ({ status: 255, stdout: "", stderr: "sandbox is not running" }),
          undefined,
          execute,
          clearStoppedNativeHome,
        ),
      ).toThrow(
        "Stopped native-home cleanup failed (cleanup-helper-image-unavailable). container is not running",
      );
      expect(clearStoppedNativeHome).toHaveBeenCalledExactlyOnceWith("/sandbox/.openclaw", []);
    },
  );

  it("does not bypass an unsafe native-tree refusal", () => {
    const runOpenshell = vi.fn(() => ({
      status: 21,
      stdout: "",
      stderr: "unsafe protected native-home ancestor",
    }));
    const runPrivileged = vi.fn();
    const clearStoppedNativeHome = vi.fn();
    const runAsSandboxUser = vi.fn();

    expect(() =>
      wipeAgentNativeHome(
        "alpha",
        "openclaw",
        runOpenshell,
        undefined,
        runPrivileged,
        clearStoppedNativeHome,
        runAsSandboxUser,
      ),
    ).toThrow("unsafe protected native-home ancestor");
    expect(runPrivileged).not.toHaveBeenCalled();
    expect(clearStoppedNativeHome).not.toHaveBeenCalled();
    expect(runAsSandboxUser).not.toHaveBeenCalled();
  });

  it.each([
    {
      agent: "langchain-deepagents-code",
      sandboxUser: DEEP_AGENTS_CODE_SANDBOX_USER,
      state: "registered",
      openshellDriver: "mxc",
    },
    {
      agent: "langchain-deepagents-code",
      sandboxUser: DEEP_AGENTS_CODE_SANDBOX_USER,
      state: "pending",
      openshellDriver: undefined,
    },
    { agent: "hermes", sandboxUser: "998:999", state: "registered", openshellDriver: "mxc" },
    { agent: "openclaw", sandboxUser: "998:998", state: "registered", openshellDriver: "mxc" },
    { agent: undefined, sandboxUser: "998:998", state: "registered", openshellDriver: "mxc" },
    { agent: null, sandboxUser: "998:998", state: "registered", openshellDriver: "mxc" },
    { agent: "", sandboxUser: "998:998", state: "registered", openshellDriver: "mxc" },
    { agent: "hermes", sandboxUser: "998:999", state: "pending", openshellDriver: undefined },
  ])(
    "destroys a $state $agent sandbox through its provider's pinned sandbox user",
    async ({ agent, sandboxUser, openshellDriver }) => {
      const events: string[] = [];
      const base = createInMemoryRuntimeProviderBundle({
        providerId: "mxc",
        workloadProfile: {
          support: null,
          hostArchitectures: ["x64"],
          managedImageSelectionPolicy: "prefer-managed",
          legacyDockerfileBuilds: false,
        },
      });
      const control = base.lifecycle.privilegedSandboxControl;
      const failure = { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const execute = vi.fn((_input: { readonly command: readonly string[] }) => {
        events.push("privileged");
        return failure;
      });
      const executeAsSandboxUser = vi.fn(() => {
        events.push("sandbox-user");
        return { ...failure, status: 0 };
      });
      const identity = {
        schemaVersion: 1 as const,
        providerId: "mxc",
        resourceHandle: "in-memory:alpha",
        ownershipSha256: null,
      };
      const bundle = {
        ...base,
        cleanup: {
          ...base.cleanup,
          captureDestroyIdentity: () => identity,
          captureDestroyIdentityByName: () => identity,
        },
        lifecycle: {
          ...base.lifecycle,
          privilegedSandboxControl: { ...control, execute, executeAsSandboxUser },
        },
      };
      const sandbox: SandboxEntry = {
        name: "alpha",
        agent,
        openshellDriver,
        ...(openshellDriver === undefined ? { pendingRouteReservation: true as const } : {}),
        gatewayName: "nemoclaw",
        lifecycleGeneration: "alpha-generation-1",
      };
      let current: SandboxEntry | null = sandbox;
      const ok = { status: 0, stdout: "", stderr: "" };
      const handlers: Record<string, () => { status: number; stdout: string; stderr: string }> = {
        "sandbox:exec": () => {
          events.push("openshell-exec");
          return { status: 255, stdout: "", stderr: "sandbox is not running" };
        },
        "sandbox:delete": () => {
          events.push("delete");
          current = null;
          return ok;
        },
        "sandbox:get": () =>
          current
            ? { status: 0, stdout: "Name: alpha\nPhase: Ready", stderr: "" }
            : { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" },
      };
      const runOpenshell = vi.fn(
        (args: string[]) => handlers[`${String(args[0])}:${String(args[1])}`]?.() ?? ok,
      );
      const stopInferenceResources = vi.fn();
      const onMutationStarted = vi.fn();

      const result = await executeSandboxDestroy({
        force: false,
        deleteGatewayName: "nemoclaw",
        getSandbox: () => current,
        listSandboxes: () => ({ sandboxes: current ? [current] : [] }),
        runOpenshell,
        sandbox,
        sandboxConfirmedAbsent: false,
        sandboxName: "alpha",
        stopInferenceResources,
        onMutationStarted,
        runtimeProviders: { mxc: bundle },
        expectedRuntimeProviderIdentity: identity,
        deps: { deleteConvergence: { now: () => 0, sleep: () => undefined } },
      });

      expect(result.ok, result.deleteOutput).toBe(true);
      expect(sandbox.openshellDriver).toBe(openshellDriver);
      expect(events.slice(0, 4)).toEqual([
        "openshell-exec",
        "privileged",
        "sandbox-user",
        "delete",
      ]);
      expect(executeAsSandboxUser).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sandboxName: "alpha",
          sandboxUser,
          expectedResourceHandle: "in-memory:alpha",
          command: execute.mock.calls[0]![0].command,
        }),
      );
    },
  );

  it.each([
    { condition: "provider changed", observe: () => ({ providerId: "other" }) },
    { condition: "resource changed", observe: () => ({ resourceHandle: "replacement" }) },
    { condition: "ownership changed", observe: () => ({ ownershipSha256: "replacement" }) },
    {
      condition: "probe failed",
      observe: () => {
        throw new Error("runtime identity probe unavailable");
      },
    },
  ])(
    "preserves a pending sandbox without mutation when its identity $condition",
    async ({ observe }) => {
      const identity = {
        schemaVersion: 1 as const,
        providerId: "mxc",
        resourceHandle: "in-memory:alpha",
        ownershipSha256: null,
      };
      const base = createInMemoryRuntimeProviderBundle({
        providerId: "mxc",
        workloadProfile: {
          support: null,
          hostArchitectures: ["x64"],
          managedImageSelectionPolicy: "prefer-managed",
          legacyDockerfileBuilds: false,
        },
      });
      const captureDestroyIdentityByName = vi.fn(() => ({ ...identity, ...observe() }));
      const sandbox: SandboxEntry = Object.freeze({ name: "alpha", pendingRouteReservation: true });
      const runOpenshell = vi.fn();
      const stopInferenceResources = vi.fn();
      const onMutationStarted = vi.fn();
      const result = await executeSandboxDestroy({
        force: false,
        deleteGatewayName: "nemoclaw",
        getSandbox: () => sandbox,
        runOpenshell,
        sandbox,
        sandboxConfirmedAbsent: false,
        sandboxName: "alpha",
        stopInferenceResources,
        onMutationStarted,
        runtimeProviders: {
          mxc: { ...base, cleanup: { ...base.cleanup, captureDestroyIdentityByName } },
        },
        expectedRuntimeProviderIdentity: identity,
      });
      expect(result.ok).toBe(false);
      expect(result.deleteOutput).toContain("before destroy preparation");
      expect(captureDestroyIdentityByName).toHaveBeenCalledExactlyOnceWith("alpha");
      expect(runOpenshell).not.toHaveBeenCalled();
      expect(stopInferenceResources).not.toHaveBeenCalled();
      expect(onMutationStarted).not.toHaveBeenCalled();
    },
  );
});

function cleanupFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-home-script-"));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "sandbox");
  fs.mkdirSync(root);
  let command: readonly string[] = [];
  wipeAgentNativeHome(
    "alpha",
    "langchain-deepagents-code",
    (args) => {
      command = args.slice(args.indexOf("--") + 1);
      return { status: 0, stdout: "", stderr: "" };
    },
    undefined,
  );
  // Execute the production shell with only its filesystem root relocated.
  const script = command[2]!.replace("root='/sandbox'", 'root="$NATIVE_HOME_FIXTURE"');
  const protectedPaths = command.slice(4).map((entry) => entry.replace("/sandbox", root));
  const run = (rmMode = "normal") =>
    spawnSync(
      "sh",
      [
        "-c",
        [
          "rm() {",
          '  case "$3" in',
          '    */.a-denied) case "$NATIVE_HOME_RM_MODE" in denied) return 1;; retained) return 0;; esac;;',
          "  esac",
          '  /bin/rm "$@"',
          "}",
          script,
        ].join("\n"),
        command[3]!,
        ...protectedPaths,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, NATIVE_HOME_FIXTURE: root, NATIVE_HOME_RM_MODE: rmMode },
      },
    );
  return { directory, root, run };
}

describe("native-home cleanup shell", () => {
  it.each([
    { mode: "normal", status: 0, remains: false },
    { mode: "denied", status: 1, remains: true },
    { mode: "retained", status: 22, remains: true },
  ])("finishes eligible entries and verifies remaining state after $mode removal", (testCase) => {
    const { root, run } = cleanupFixture();
    fs.mkdirSync(path.join(root, ".deepagents"));
    const protectedFile = path.join(root, ".deepagents", ".env");
    fs.writeFileSync(protectedFile, "synthetic protected configuration");
    fs.writeFileSync(path.join(root, ".a-denied"), "first entry");
    fs.writeFileSync(path.join(root, "z-owned"), "later entry");

    const result = run(testCase.mode);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(testCase.status);
    expect(fs.existsSync(path.join(root, "z-owned"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".a-denied"))).toBe(testCase.remains);
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("synthetic protected configuration");
    expect(run().status).toBe(0);
    expect(fs.existsSync(path.join(root, ".a-denied"))).toBe(false);
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("synthetic protected configuration");
  });

  it.each([
    {
      target: "root",
      status: 20,
      linkPath: (root: string) => {
        fs.rmdirSync(root);
        return root;
      },
    },
    {
      target: "protected ancestor",
      status: 21,
      linkPath: (root: string) => path.join(root, ".deepagents"),
    },
  ])("refuses a symlink at the $target without following it", ({ linkPath, status }) => {
    const { directory, root, run } = cleanupFixture();
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "retained"), "outside state");
    fs.symlinkSync(outside, linkPath(root));

    const result = run();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(fs.readFileSync(path.join(outside, "retained"), "utf8")).toBe("outside state");
  });
});
