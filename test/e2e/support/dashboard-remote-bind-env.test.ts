// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { isValidName } from "../../../src/lib/name-validation.ts";

import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  buildDashboardRemoteBindEnv,
  dashboardRemoteBindSandboxName,
  REMOTE_API_REFUSAL_PROBE,
  dashboardForwardIsRunning,
  dashboardRemoteBindConnectStarted,
} from "../live/dashboard-remote-bind-env.ts";

describe("dashboard remote-bind E2E environment", () => {
  it("prepares remote dashboard exposure during install and onboarding", () => {
    const env = buildDashboardRemoteBindEnv("e2e-dashboard-bind", {
      NVIDIA_INFERENCE_API_KEY: "test-key",
    });

    expect(env).toMatchObject({
      NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-dashboard-bind",
      NVIDIA_INFERENCE_API_KEY: "test-key",
    });
    expect(env.PATH).toContain(buildAvailabilityProbeEnv().PATH);
  });

  it("does not allow command overlays to disable remote exposure preparation", () => {
    const env = buildDashboardRemoteBindEnv("e2e-dashboard-bind", {
      NEMOCLAW_DASHBOARD_BIND: "127.0.0.1",
    });

    expect(env.NEMOCLAW_DASHBOARD_BIND).toBe("0.0.0.0");
  });

  it("accepts recovery proof while connect remains interactive", () => {
    expect(
      dashboardRemoteBindConnectStarted(
        {
          exitCode: null,
          stdout: "\u001B[32m✓\u001B[0m Dashboard port forward re-established.\n",
          stderr: "client_loop: send disconnect: Broken pipe\n",
        },
        "e2e-dashboard-bind",
        "18789",
      ),
    ).toBe(true);
  });

  it("accepts recovery proof after the interactive connect reaches its test deadline (#9606)", () => {
    const timedOutRecovery = {
      exitCode: 143,
      timedOut: true,
      stdout: "\u001B[32m✓\u001B[0m Dashboard port forward re-established.\n",
      stderr: "client_loop: send disconnect: Broken pipe\n",
    };

    expect(dashboardRemoteBindConnectStarted(timedOutRecovery, "e2e-dashboard-bind", "18789")).toBe(
      true,
    );
  });

  it("rejects a connect result with no numeric exit code and no forward proof", () => {
    expect(
      dashboardRemoteBindConnectStarted(
        {
          exitCode: null,
          stdout: "Connecting to sandbox...\n",
          stderr: "",
        },
        "e2e-dashboard-bind",
        "18789",
      ),
    ).toBe(false);
  });

  it.each([
    ["e2e-dashboard-bind 0.0.0.0 18789 4242 running", true],
    ["e2e-dashboard-bind 0.0.0.0 18789 4242 \u001B[32mrunning\u001B[39m", true],
    ["e2e-dashboard-bind 0.0.0.0 18789 4242 not running", false],
    ["e2e-dashboard-bind 0.0.0.0 18789 4242 stopped", false],
  ])("recognizes only the exact running forward status: %s", (forwardLine, expected) => {
    expect(dashboardForwardIsRunning(forwardLine)).toBe(expected);
  });

  it("rejects a completed nonzero connect even when it printed recovery proof (#9606)", () => {
    expect(
      dashboardRemoteBindConnectStarted(
        {
          exitCode: 1,
          timedOut: false,
          stdout: "Dashboard port forward re-established.\n",
          stderr: "connect failed\n",
        },
        "e2e-dashboard-bind",
        "18789",
      ),
    ).toBe(false);
  });

  it("rejects a timed-out interactive connect without background-forward proof (#9606)", () => {
    expect(
      dashboardRemoteBindConnectStarted(
        {
          exitCode: 143,
          timedOut: true,
          stdout: "Connecting to sandbox...\n",
          stderr: "client_loop: send disconnect: Broken pipe\n",
        },
        "e2e-dashboard-bind",
        "18789",
      ),
    ).toBe(false);
  });
});

describe("remote API refusal probe", () => {
  it.each([false, true])(
    "distinguishes listening=%s from a refused connection",
    async (listening) => {
      const server = net.createServer((socket) => socket.end());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as net.AddressInfo).port;
      const close = () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await (listening ? Promise.resolve() : close());
      try {
        const result = await promisify(execFile)(
          process.execPath,
          ["-e", REMOTE_API_REFUSAL_PROBE, "127.0.0.1", String(port)],
          { timeout: 10_000 },
        ).then(
          () => 0,
          (error: { code: number }) => error.code,
        );
        expect(result).toBe(listening ? 1 : 0);
      } finally {
        await (listening ? close() : Promise.resolve());
      }
    },
    15_000,
  );
});

it("selects dashboard-remote-bind when its host-network probe helper changes", () => {
  const plan = buildE2eWorkflowPlan(
    {},
    {
      changedFiles: ["test/e2e/live/dashboard-remote-bind-env.ts"],
    },
  );
  expect(plan.catalogueMatrices["nvidia-inference"].map((row) => row.id)).toContain(
    "dashboard-remote-bind",
  );
});

it.each(["e2e-dashboard-bind", "e2e-wsl", "abcdefghijklmnopqrs", "abcdefghij-klmnopqr"])(
  "keeps both agent sandbox names valid for base %s",
  (baseName) => {
    const names = ["openclaw", "hermes"].map((agent) =>
      dashboardRemoteBindSandboxName(baseName, agent as "openclaw" | "hermes"),
    );
    expect(names.every((name) => isValidName(name))).toBe(true);
    expect(names.map((name) => buildDashboardRemoteBindEnv(name).NEMOCLAW_SANDBOX_NAME)).toEqual(
      names,
    );
    expect(new Set(names).size).toBe(2);
  },
);
