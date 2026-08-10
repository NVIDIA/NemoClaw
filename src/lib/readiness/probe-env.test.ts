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
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 15_000,
      }),
    );
  });

  it("allows callers to lower the bounded readiness probe limits", () => {
    subprocess.spawnSync.mockReturnValue({ status: 0, stdout: "ready", stderr: "" });
    const capture = createSystemReadinessCapture({ PATH: "/usr/bin" });

    capture(["probe"], { maxBuffer: 2048, timeout: 2500 });

    expect(subprocess.spawnSync).toHaveBeenCalledWith(
      "probe",
      [],
      expect.objectContaining({ maxBuffer: 2048, timeout: 2500 }),
    );
  });

  it.each([
    "gateway\0spoof",
    "gateway\rspoof",
    "gateway\nspoof",
  ])("rejects an invalid gateway name before spawning: %j", (gatewayName) => {
    expect(() => buildSystemReadinessProbeEnv({}, { gatewayName })).toThrow(
      "Readiness gateway name contains an invalid character.",
    );
    expect(subprocess.spawnSync).not.toHaveBeenCalled();
  });
});
