// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assert, describe, expect, it, vi } from "vitest";

import { captureHermesPortableOpenShellExecutableAuthority } from "../adapters/openshell/resolve-shared";
import { PodmanExecutablePermissionError } from "../adapters/podman/executable-authority";
import { runOnboardCommand } from "./command";

/** Expose the exit code without terminating the test process. */
function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboarding command failures", () => {
  it("redacts rejected executable paths before rethrowing onboarding failures (#11717)", async () => {
    const secret = `nvapi-${"a".repeat(60)}`;
    const rejectedPath = `/opt/${secret}/\u001b[31m/bin`;
    const error = vi.fn();
    const runVersion = vi.fn();
    const failure: unknown = await runOnboardCommand({
      flags: {},
      env: {},
      runOnboard: async () => {
        captureHermesPortableOpenShellExecutableAuthority(
          "/opt/openshell",
          {},
          {},
          {
            resolve: () => "/opt/openshell",
            realpath: (filePath) => filePath,
            uid: 1000,
            lstat: () => {
              throw new PodmanExecutablePermissionError(rejectedPath, 0o40775n);
            },
            runVersion,
          },
        );
      },
      error,
      exit: exitWithCode,
    }).catch((caught: unknown) => caught);

    assert(failure instanceof Error);
    expect(failure.message).not.toContain(secret);
    expect(failure.stack).not.toContain(secret);
    expect(failure.message).toContain("<REDACTED>");
    expect(failure.message).not.toContain("\u001b");
    expect(failure.message).toContain("\\u001b");
    expect(failure.message).toContain("has mode 0775");
    expect(failure.message).toContain(
      "Remove group and other write permission from this path, then retry.",
    );
    expect(error).not.toHaveBeenCalled();
    expect(runVersion).not.toHaveBeenCalled();
  });

  it("re-throws a non-cancellation, non-gateway error so genuine bugs still surface (#7627)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("unexpected boom");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("unexpected boom");
  });

  it("returns without rethrowing when a prompt rejects with SIGINT (#7439)", async () => {
    const exit = vi.fn<(code: number) => never>();
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw Object.assign(new Error("Prompt interrupted"), {
            code: "SIGINT",
          });
        },
        error: () => {},
        exit,
      }),
    ).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("rethrows non-cancellation onboarding failures unchanged (#5976)", async () => {
    const failure = new Error("docker is not reachable");
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw failure;
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toBe(failure);
    expect(failure.message).toBe("docker is not reachable");
  });
});
