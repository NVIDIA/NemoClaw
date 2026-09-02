// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENSHELL_V0116_QUALIFICATION } from "../fixtures/openshell-v0116-qualification.ts";
import {
  OPENSHELL_V0116_DRIVER_ENVIRONMENT_PROBES,
  verifyOpenShellDriverEnvironmentBehavior,
} from "../live/openshell-v0116-driver-environment-behavior.ts";

const temporaryDirectories: string[] = [];

function checkoutFixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-behavior-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("OpenShell 0.0.116 driver environment behavior", () => {
  it("runs the exact compiled driver tests for hostile input, normal input, and managed TLS", () => {
    const sourceRoot = checkoutFixture();
    const calls: { args: readonly string[]; command: string; cwd: string }[] = [];
    const runCommand = vi.fn((command: string, args: readonly string[], cwd: string) => {
      calls.push({ args, command, cwd });
      return command === "git"
        ? { status: 0, stderr: "", stdout: `${OPENSHELL_V0116_QUALIFICATION.sourceRevision}\n` }
        : {
            status: 0,
            stderr: "Finished test profile",
            stdout: "running 1 test\ntest result: ok. 1 passed; 0 failed;",
          };
    });

    expect(verifyOpenShellDriverEnvironmentBehavior({ runCommand, sourceRoot })).toMatchObject({
      drivers: [
        {
          driver: "docker",
          passedClaims: ["untrusted-server-name", "normal-environment", "managed-tls"],
        },
        {
          driver: "podman",
          passedClaims: ["untrusted-server-name", "normal-environment", "managed-tls"],
        },
        {
          driver: "vm",
          passedClaims: ["untrusted-server-name", "normal-environment", "managed-tls"],
        },
      ],
      sourceRevision: OPENSHELL_V0116_QUALIFICATION.sourceRevision,
      version: "0.0.116",
    });
    expect(calls[0]).toEqual({
      args: ["rev-parse", "HEAD"],
      command: "git",
      cwd: fs.realpathSync(sourceRoot),
    });
    expect(calls.slice(1).map(({ args }) => args)).toEqual(
      OPENSHELL_V0116_DRIVER_ENVIRONMENT_PROBES.flatMap(({ packageName, tests }) =>
        [...new Set(tests.map(({ name }) => name))].map((name) => [
          "test",
          "--locked",
          "-p",
          packageName,
          "--lib",
          name,
          "--",
          "--exact",
        ]),
      ),
    );
  });

  it("fails when a compiled driver behavior test does not execute exactly once", () => {
    const sourceRoot = checkoutFixture();
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stderr: "",
        stdout: `${OPENSHELL_V0116_QUALIFICATION.sourceRevision}\n`,
      })
      .mockReturnValueOnce({
        status: 0,
        stderr: "",
        stdout: "test result: ok. 0 passed; 0 failed; 123 filtered out;",
      });

    expect(() => verifyOpenShellDriverEnvironmentBehavior({ runCommand, sourceRoot })).toThrow(
      "OpenShell docker driver environment behavior",
    );
  });
});
