// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const subprocess = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: subprocess.spawnSync,
}));

import { collectHostObservations } from "./host";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production host readiness collection (#7411)", () => {
  it("runs every child with a credential-free replacement environment", () => {
    vi.stubEnv("OPENSHELL_GATEWAY_AUTH_TOKEN", "gateway-secret");
    vi.stubEnv("OPENSHELL_SANDBOX_TOKEN", "sandbox-secret");
    vi.stubEnv("XDG_API_TOKEN", "prefix-secret");
    subprocess.spawnSync.mockReturnValue({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "not found",
    });

    collectHostObservations({ now: () => new Date("2026-08-07T12:00:00.000Z") });

    expect(subprocess.spawnSync.mock.calls.length).toBeGreaterThan(0);

    expect(
      subprocess.spawnSync.mock.calls.every(([, , options]) => {
        const env = options?.env as NodeJS.ProcessEnv | undefined;
        return (
          env !== undefined &&
          env.OPENSHELL_GATEWAY_AUTH_TOKEN === undefined &&
          env.OPENSHELL_SANDBOX_TOKEN === undefined &&
          env.XDG_API_TOKEN === undefined
        );
      }),
    ).toBe(true);
  });

  it("does not contact Docker through an unsupported configured endpoint", () => {
    vi.stubEnv("DOCKER_HOST", "tcp://attacker.example:2375");
    subprocess.spawnSync.mockImplementation((command: string, args: readonly string[] = []) =>
      command === "sh" && args.at(-1) === "docker"
        ? { error: undefined, status: 0, stdout: "/usr/bin/docker\n", stderr: "" }
        : { error: undefined, status: 1, stdout: "", stderr: "not found" },
    );

    const snapshot = collectHostObservations({
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    });

    expect(snapshot.observations).toMatchObject({
      dockerHostInvalid: true,
      dockerInstalled: true,
      dockerReachable: false,
    });
    expect(subprocess.spawnSync.mock.calls.some(([command]) => command === "docker")).toBe(false);
  });
});
