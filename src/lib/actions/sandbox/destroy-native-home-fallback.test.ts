// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

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
      ["langchain-deepagents-code", "openclaw"].map((agent) => ({ ...scenario, agent })),
    ),
  )(
    "completes $agent cleanup as the sandbox owner after $initial",
    ({ openshellResult, agent }) => {
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
    { agent: "langchain-deepagents-code", sandboxUser: DEEP_AGENTS_CODE_SANDBOX_USER },
    { agent: "openclaw", sandboxUser: "998:998" },
    { agent: undefined, sandboxUser: "998:998" },
    { agent: null, sandboxUser: "998:998" },
    { agent: "", sandboxUser: "998:998" },
  ])(
    "destroys $agent through the pinned sandbox user after both cleanup passes fail",
    async ({ agent, sandboxUser }) => {
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
        cleanup: { ...base.cleanup, captureDestroyIdentity: () => identity },
        lifecycle: {
          ...base.lifecycle,
          privilegedSandboxControl: { ...control, execute, executeAsSandboxUser },
        },
      };
      const sandbox: SandboxEntry = {
        name: "alpha",
        agent,
        openshellDriver: "mxc",
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

      await executeSandboxDestroy({
        force: false,
        deleteGatewayName: "nemoclaw",
        getSandbox: () => current,
        listSandboxes: () => ({ sandboxes: current ? [current] : [] }),
        runOpenshell,
        sandbox,
        sandboxConfirmedAbsent: false,
        sandboxName: "alpha",
        stopInferenceResources: vi.fn(),
        onMutationStarted: vi.fn(),
        runtimeProviders: { mxc: bundle },
        expectedRuntimeProviderIdentity: identity,
        deps: { deleteConvergence: { now: () => 0, sleep: () => undefined } },
      });

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
});
