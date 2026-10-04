// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
  dockerSpawnSync: vi.fn(),
}));

vi.mock("../../adapters/docker/run", () => ({ dockerCapture: mocks.dockerCapture }));
vi.mock("../../adapters/docker/exec", () => ({ dockerSpawnSync: mocks.dockerSpawnSync }));

import { createDockerPrivilegedSandboxControl } from "./docker-privileged-sandbox-control";

const CONTAINER_ID = "a".repeat(64);

function exactInspect(running = true, sandboxName = "alpha"): string {
  return [
    CONTAINER_ID,
    `/openshell-default--${sandboxName}-sandbox-id`,
    String(running),
    JSON.stringify({
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/sandbox-name": sandboxName,
    }),
  ].join("\t");
}

describe("Docker privileged exact target", () => {
  it("executes in the pinned running replacement without mutable-name discovery (#11905)", () => {
    mocks.dockerCapture.mockReturnValue(exactInspect());
    const control = createDockerPrivilegedSandboxControl();

    expect(
      control.buildLegacyDockerArgv?.({
        sandbox: { name: "alpha", openshellDriver: "docker" },
        sandboxName: "alpha",
        registeredSandboxNames: ["alpha"],
        command: ["true"],
        expectedResourceHandle: CONTAINER_ID,
        sanitizeEnvironment: false,
      }),
    ).toEqual(["exec", "--user", "root", CONTAINER_ID, "true"]);
    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["inspect", CONTAINER_ID]),
      expect.any(Object),
    );
  });

  it.each([
    ["stopped", exactInspect(false)],
    ["wrong sandbox", exactInspect(true, "replacement")],
  ])("rejects a %s pinned target", (_label, inspect) => {
    mocks.dockerCapture.mockReturnValue(inspect);
    const control = createDockerPrivilegedSandboxControl();

    expect(() =>
      control.buildLegacyDockerArgv?.({
        sandbox: { name: "alpha", openshellDriver: "docker" },
        sandboxName: "alpha",
        registeredSandboxNames: ["alpha"],
        command: ["true"],
        expectedResourceHandle: CONTAINER_ID,
        sanitizeEnvironment: false,
      }),
    ).toThrow(/identity changed/u);
  });
});
