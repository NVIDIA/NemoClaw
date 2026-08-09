// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const subprocess = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: subprocess.spawnSync,
}));

import { buildSystemReadinessProbeEnv, createSystemReadinessCapture } from "./probe-env";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("system readiness child environment (#7411)", () => {
  it("uses a replacement environment even when a caller supplies another env", () => {
    subprocess.spawnSync.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "ready\n",
      stderr: "",
    });
    const env = buildSystemReadinessProbeEnv(
      {
        HOME: "/home/test",
        PATH: "/usr/bin",
        OPENSHELL_TOKEN: "ambient-secret",
        XDG_API_TOKEN: "prefix-secret",
      },
      { gatewayName: "target-gateway" },
    );
    const capture = createSystemReadinessCapture(env);

    expect(
      capture(["probe", "--readonly"], {
        env: { OPENSHELL_GATEWAY_AUTH_TOKEN: "caller-secret" },
      }),
    ).toBe("ready");
    expect(subprocess.spawnSync).toHaveBeenCalledWith(
      "probe",
      ["--readonly"],
      expect.objectContaining({
        env: {
          HOME: "/home/test",
          PATH: "/usr/bin",
          OPENSHELL_GATEWAY: "target-gateway",
        },
        shell: false,
      }),
    );
  });
});
