// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  executeHermesPortableGatewaySupervisorAction,
  type HermesPortableLifecycleDeps,
} from "./hermes-portable-lifecycle";
import {
  createHermesPortableLifecycleTestReceipt,
  createHermesPortableLifecycleTestDeps,
  SANDBOX,
  GATEWAY,
  GENERATION,
  CONTAINER_ID,
  IMAGE,
  SANDBOX_ID,
  POLICY,
  LABELS,
} from "./hermes-portable-lifecycle.test-fixture";
import { openshellMutationCalls } from "./hermes-portable-lifecycle.test-fixtures";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-control-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
function activeReceipt() {
  const policyPath = path.join(stateDir, "policy.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
  return createHermesPortableLifecycleTestReceipt({
    agent: loadAgent("hermes"),
    stateDir,
    policyPath,
    homeDir: "/home/test",
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    containerId: CONTAINER_ID,
    imageDigest: IMAGE,
    sandboxId: SANDBOX_ID,
    labels: LABELS,
  });
}
function lifecycleDeps(
  receipt: ReturnType<typeof activeReceipt>,
  running = true,
  options: Parameters<typeof createHermesPortableLifecycleTestDeps>[3] = {},
) {
  return createHermesPortableLifecycleTestDeps(stateDir, receipt, running, options);
}
function lifecycleContext() {
  return {
    agent: "hermes",
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    openshellDriver: "docker",
    provider: "ollama",
  };
}

describe("Hermes portable gateway control", () => {
  function controlWithLock(
    deps: HermesPortableLifecycleDeps,
    request: Partial<Parameters<typeof executeHermesPortableGatewaySupervisorAction>[2]> = {},
  ) {
    return withMcpLifecycleLock(
      SANDBOX,
      () =>
        executeHermesPortableGatewaySupervisorAction(
          SANDBOX,
          lifecycleContext(),
          {
            action: "recover",
            nonce: "e".repeat(64),
            timeoutMs: 210000,
            ...request,
          },
          deps,
        ),
      { stateDir: path.join(stateDir, "state") },
    );
  }

  it.each(["before", "after"] as const)(
    "holds the lifecycle lock until the %s-control policy observation settles",
    async (phase) => {
      const fixture = lifecycleDeps(activeReceipt());
      const capture = fixture.podman.getMockImplementation()!;
      const accepted = { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" };
      const control = vi.fn(() => accepted);
      fixture.podman.mockImplementation((args) =>
        args.includes("/usr/local/bin/nemoclaw-gateway-control") ? control() : capture(args),
      );
      let release!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const immediate = () => ({ status: 0, stdout: Buffer.from(POLICY), stderr: Buffer.alloc(0) });
      const delayed = async () => {
        entered();
        await pending;
        throw new Error("policy observation refused");
      };
      const captures = phase === "before" ? [delayed] : [immediate, delayed];
      const capturePolicy = vi.fn(() => captures.shift()!());
      const operation = controlWithLock({ ...fixture.deps, capturePolicy });
      const result = expect(operation).rejects.toThrow("policy observation refused");
      await observing;
      let competitorEntered = false;
      const competitor = withMcpLifecycleLock(
        SANDBOX,
        async () => {
          competitorEntered = true;
        },
        { stateDir: path.join(stateDir, "state"), pollIntervalMs: 1 },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(competitorEntered).toBe(false);
      expect(control).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      release();
      await result;
      await competitor;
      expect(competitorEntered).toBe(true);
    },
  );

  it.each([
    { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" },
    { status: 1, stdout: "", stderr: "SECRET_BOUNDARY_REFUSED" },
  ])("returns the receipt-owned privileged validator result: $status", async (result) => {
    const fixture = lifecycleDeps(activeReceipt());
    const capture = fixture.podman.getMockImplementation()!;
    fixture.podman.mockImplementation((args) =>
      args.includes("/usr/local/bin/nemoclaw-gateway-control") ? result : capture(args),
    );
    await expect(controlWithLock(fixture.deps)).resolves.toEqual(result);
    const command = fixture.podman.mock.calls.find(([args]) =>
      args.includes("/usr/local/bin/nemoclaw-gateway-control"),
    )?.[0];
    expect(command?.slice(0, 2)).toEqual(["container", "exec"]);
    expect(command?.slice(-6)).toEqual([
      "--user",
      "root",
      CONTAINER_ID,
      "/usr/local/bin/nemoclaw-gateway-control",
      "recover",
      "e".repeat(64),
    ]);
    expect(command).toEqual(expect.arrayContaining(["LD_PRELOAD=", "BASH_ENV=", "PYTHONPATH="]));
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(0);
  });

  it.each([
    { label: "another pinned container", request: { expectedContainerId: "b".repeat(64) } },
    { label: "a restart", request: { action: "restart" as const } },
    { label: "an invalid nonce", request: { nonce: "untrusted" } },
  ])("refuses privileged control for $label before execution", async ({ request }) => {
    const fixture = lifecycleDeps(activeReceipt());
    await expect(controlWithLock(fixture.deps, request)).rejects.toThrow();
    expect(
      fixture.podman.mock.calls.some(([args]) =>
        args.includes("/usr/local/bin/nemoclaw-gateway-control"),
      ),
    ).toBe(false);
  });

  it("refuses a registry owner mismatch before privileged execution", async () => {
    const fixture = lifecycleDeps(activeReceipt(), true, {
      registry: { lifecycleGeneration: "other" },
    });
    await expect(controlWithLock(fixture.deps)).rejects.toThrow("registry authority disagrees");
    expect(
      fixture.podman.mock.calls.some(([args]) =>
        args.includes("/usr/local/bin/nemoclaw-gateway-control"),
      ),
    ).toBe(false);
  });

  it("rejects privileged success when container identity changes during validation", async () => {
    const fixture = lifecycleDeps(activeReceipt());
    const capture = fixture.podman.getMockImplementation()!;
    let executed = false;
    const validate = () => {
      executed = true;
      return { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" };
    };
    fixture.podman.mockImplementation((args) => {
      const result = args.includes("/usr/local/bin/nemoclaw-gateway-control")
        ? validate()
        : capture(args);
      return executed && args[1] === "inspect"
        ? { ...result, stdout: result.stdout.replace(CONTAINER_ID, "b".repeat(64)) }
        : result;
    });
    await expect(controlWithLock(fixture.deps)).rejects.toThrow();
    expect(executed).toBe(true);
  });

  it("requires the lifecycle lock before privileged control", async () => {
    const fixture = lifecycleDeps(activeReceipt());
    await expect(
      executeHermesPortableGatewaySupervisorAction(
        SANDBOX,
        lifecycleContext(),
        {
          action: "recover",
          nonce: "e".repeat(64),
          timeoutMs: 100,
        },
        fixture.deps,
      ),
    ).rejects.toThrow("requires the sandbox lifecycle lock");
    expect(fixture.podman).not.toHaveBeenCalled();
  });
});
