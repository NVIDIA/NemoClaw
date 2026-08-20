// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

const recoverProcessesMock = vi.hoisted(() =>
  vi.fn(() => ({
    checked: true,
    wasRunning: true,
    recovered: false,
    forwardRecovered: false,
  })),
);

vi.mock("./gateway-target", () => ({
  getSandboxTargetGatewayName: vi.fn(() => "nemoclaw"),
}));

import {
  createDockerRuntimeProviderBundle,
  createKubernetesRuntimeProviderBundle,
} from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { startSandbox } from "./start";

describe("sandbox start default readiness", () => {
  it(
    "recovers through Error, Provisioning, and Ready before gateway verification (#9753)",
    testTimeoutOptions(15_000),
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-readiness-"));
      vi.stubEnv("HOME", home);
      const listOutputs = ["my-sandbox Error", "my-sandbox Provisioning", "my-sandbox Ready"];
      const captureSandboxList = vi.fn(() => ({
        status: 0,
        output: listOutputs.shift() ?? "my-sandbox Ready",
        stdout: "",
        stderr: "",
      }));
      const recoverSandbox = vi.fn(() => ({
        recovered: true,
        via: "started-stopped-original" as const,
        containerName: "openshell-my-sandbox",
      }));
      const runtimeProviders = createRuntimeProviderBundleRegistry([
        [
          "docker",
          createDockerRuntimeProviderBundle({
            findLabeledSandboxContainers: vi.fn(() => [
              {
                name: "openshell-my-sandbox",
                status: "Exited (0) 2 hours ago",
                running: false,
              },
            ]),
            hasPortableLifecycleReceipt: vi.fn(() => false),
            isRuntimeDown: vi.fn(() => false),
            printRuntimeDownGuidance: vi.fn(),
            recoverSandbox,
            recoverPortableSandbox: vi.fn(() => ({ kind: "not-installed" as const })),
            unpauseContainer: vi.fn(() => ({ status: 0 })),
          }),
        ],
        ["kubernetes", createKubernetesRuntimeProviderBundle()],
      ]);
      const verifyGateway = vi.fn(() => Promise.resolve());

      try {
        const result = await startSandbox("my-sandbox", {
          allowDockerRuntimeInspection: false,
          captureSandboxList,
          environment: { ...process.env, HOME: home },
          getSandbox: () => ({ name: "my-sandbox", openshellDriver: "docker" }),
          runtimeProviders,
          restoreLockedStartupAccess: vi.fn(),
          restoreProcessState: recoverProcessesMock,
          verifyGateway,
          log: vi.fn(),
          withLifecycleLock: async (_sandboxName, operation) => operation(),
        });

        expect(result.exitCode).toBe(0);
        expect(captureSandboxList).toHaveBeenCalledTimes(3);
        expect(recoverProcessesMock).toHaveBeenCalledWith("my-sandbox");
        expect(verifyGateway).toHaveBeenCalledWith("my-sandbox");
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
