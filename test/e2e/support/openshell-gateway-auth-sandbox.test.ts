// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createGatewayAuthSandbox } from "../live/openshell-gateway-auth-source-contract-helpers.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));

it("uses the gateway-issued launch token and deletes its exact fixture sandbox", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-sandbox-test-"));
  const id = "11111111-2222-3333-4444-555555555555";
  const cleanup = { add: vi.fn() };
  try {
    const configPath = path.join(stateDir, "gateway.toml");
    fs.writeFileSync(configPath, 'sandbox_label = "fixture"\n');
    const bundleDir = path.join(
      stateDir,
      "runtime-state",
      "openshell",
      "docker-sandbox-tokens",
      "fixture",
      id,
    );
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "supervisor-auth.json"),
      JSON.stringify({ gateway_token: "fixture-issued-session" }),
    );
    spawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ id, name: "auth-contract", phase: "Ready" }),
    });
    expect(createGatewayAuthSandbox({ cleanup, configPath, port: 12345, stateDir })).toEqual({
      name: "auth-contract",
      token: "fixture-issued-session",
    });
    const invocation = spawn.mock.calls[1]!;
    expect(invocation[2].env.XDG_STATE_HOME).toBe(path.join(stateDir, "runtime-state"));
    expect(invocation[1]).toContain("--no-auto-providers");
    cleanup.add.mock.calls[0]![1]();
    expect(spawn.mock.lastCall?.[1]).toEqual(["sandbox", "delete", "auth-contract"]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

it("does not include sensitive command output in a fixture failure", () => {
  spawn.mockReturnValue({
    status: 1,
    stdout: "secret-output",
    stderr: "invalid token nvapi-testSecret000000",
  });
  expect(() =>
    createGatewayAuthSandbox({
      cleanup: { add: vi.fn() },
      configPath: "/unused",
      port: 12345,
      stateDir: "/unused",
    }),
  ).toThrow("OpenShell auth fixture gateway add failed (1): invalid token <REDACTED>");
});
