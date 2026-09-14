// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assert, describe, expect, it, vi } from "vitest";

import { captureHermesPortableOpenShellExecutableAuthority } from "../adapters/openshell/resolve-shared";
import { PodmanExecutablePermissionError } from "../adapters/podman/executable-authority";
import { runOnboardCommand } from "./command";
import { GatewayManagementDeclarationError } from "./gateway-management";

/** Expose the exit code without terminating the test process. */
function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboarding command failures", () => {
  it("redacts a complete private-key block before rethrowing an onboarding error", async () => {
    const payload = "synthetic-key-payload".repeat(20);
    const pem = [
      "-----BEGIN " + "PRIVATE KEY-----",
      payload,
      "-----END " + "PRIVATE KEY-----",
    ].join("\n");
    const failure = new Error(`Operation failed\n${pem}\nRetry after correcting permissions.`);
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        /** Preserve the original error object while exercising the command's failure boundary. */
        runOnboard: async () => {
          throw failure;
        },
        error: vi.fn(),
        exit: exitWithCode,
      }),
    ).rejects.toBe(failure);
    expect(failure.message).not.toContain("synthetic-key-payload");
    expect(failure.message).not.toContain("PRIVATE KEY");
    expect(failure.stack).not.toContain("synthetic-key-payload");
    expect(failure.stack).not.toContain("PRIVATE KEY");
    expect(failure.message).toContain("<REDACTED>");
    expect(failure.message).toContain("Retry after correcting permissions.");
    expect(failure.stack).toContain("Retry after correcting permissions.");
  });

  it("recursively redacts an Error cause while preserving both identities", async () => {
    const payload = "nested-cause-key-payload".repeat(20);
    const pem = [
      "-----BEGIN " + "PRIVATE KEY-----",
      payload,
      "-----END " + "PRIVATE KEY-----",
    ].join("\n");
    const cause = new Error(`Nested failure\n${pem}\nInspect the rejected executable.`);
    const failure = new Error("Onboarding failed", { cause });

    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw failure;
        },
        error: vi.fn(),
        exit: exitWithCode,
      }),
    ).rejects.toBe(failure);

    expect(failure.cause).toBe(cause);
    expect(cause.message).not.toContain(payload);
    expect(cause.stack).not.toContain(payload);
    expect(cause.message).not.toContain("PRIVATE KEY");
    expect(cause.message).toContain("<REDACTED>");
    expect(cause.message).toContain("Inspect the rejected executable.");
  });

  it("recursively redacts AggregateError entries while preserving their identities", async () => {
    const payload = "aggregate-key-payload".repeat(20);
    const pem = [
      "-----BEGIN " + "RSA PRIVATE KEY-----",
      payload,
      "-----END " + "RSA PRIVATE KEY-----",
    ].join("\n");
    const nested = new Error(`Nested failure\n${pem}\nRetry the recovery.`);
    const entries: unknown[] = [nested, `String failure\n${pem}\nInspect the gateway.`];
    const failure = new AggregateError(entries, "Onboarding cleanup failed");
    const aggregateEntries = failure.errors;

    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw failure;
        },
        error: vi.fn(),
        exit: exitWithCode,
      }),
    ).rejects.toBe(failure);

    expect(failure.errors).toBe(aggregateEntries);
    expect(failure.errors[0]).toBe(nested);
    expect(nested.message).not.toContain(payload);
    expect(nested.stack).not.toContain(payload);
    expect(String(failure.errors[1])).not.toContain(payload);
    expect(String(failure.errors[1])).not.toContain("PRIVATE KEY");
    expect(String(failure.errors[1])).toContain("<REDACTED>");
    expect(String(failure.errors[1])).toContain("Inspect the gateway.");
  });

  it("redacts a complete private-key block before reporting a typed onboarding error", async () => {
    const payload = "synthetic-key-payload".repeat(20);
    const pem = [
      "-----BEGIN " + "RSA PRIVATE KEY-----",
      payload,
      "-----END " + "RSA PRIVATE KEY-----",
    ].join("\n");
    const error = vi.fn();
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        /** Reach the typed reporting path without creating gateway resources. */
        runOnboard: async () => {
          throw new GatewayManagementDeclarationError(
            `Operation failed\n${pem}\nRetry after correcting permissions.`,
          );
        },
        error,
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");
    expect(error).toHaveBeenCalledOnce();
    const diagnostic = String(error.mock.calls[0]?.[0]);
    expect(diagnostic).not.toContain("synthetic-key-payload");
    expect(diagnostic).not.toContain("PRIVATE KEY");
    expect(diagnostic).toContain("<REDACTED>");
    expect(diagnostic).toContain("Retry after correcting permissions.");
  });

  it("redacts rejected executable paths before rethrowing onboarding failures (#11717)", async () => {
    const secret = `nvapi-${"a".repeat(60)}`;
    const rejectedPath = `/opt/${secret}/\u001b[31m/bin`;
    const error = vi.fn();
    const runVersion = vi.fn();
    const failure: unknown = await runOnboardCommand({
      flags: {},
      env: {},
      /** Exercise the production capture wrapper without starting onboarding resources. */
      runOnboard: async () => {
        captureHermesPortableOpenShellExecutableAuthority(
          "/opt/openshell",
          {},
          {},
          {
            /** Keep resolution stable so the test reaches permission validation. */
            resolve: () => "/opt/openshell",
            /** Exclude symlink rejection from the permission diagnostic scenario. */
            realpath: (filePath) => filePath,
            uid: 1000,
            /** Model a filesystem refusal carrying a secret-shaped path and terminal control. */
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
        /** Preserve a non-secret error instance across the command boundary. */
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
