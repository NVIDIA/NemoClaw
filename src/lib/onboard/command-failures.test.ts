// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { inspect } from "node:util";

import { assert, describe, expect, it, vi } from "vitest";

import { captureHermesPortableOpenShellExecutableAuthority } from "../adapters/openshell/resolve-shared";
import { PodmanExecutablePermissionError } from "../adapters/podman/executable-authority";
import { runOnboardCommand } from "./command";
import { GatewayManagementDeclarationError } from "./gateway-management";
import { attachManagedBootstrapRollbackError } from "./managed-bootstrap/adapter";

/** Expose the exit code without terminating the test process. */
function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

/** Exercise rethrowing without starting resources or replacing the original failure. */
async function rethrowOnboardFailure(failure: Error): Promise<void> {
  await expect(
    runOnboardCommand({
      flags: {},
      env: {},
      /** Supply the same graph that a failed lifecycle operation would return. */
      runOnboard: async () => {
        throw failure;
      },
      error: vi.fn(),
      exit: exitWithCode,
    }),
  ).rejects.toBe(failure);
}

/** Return the failure that crosses the command boundary. */
async function catchOnboardFailure(failure: Error): Promise<unknown> {
  return runOnboardCommand({
    flags: {},
    env: {},
    runOnboard: async () => {
      throw failure;
    },
    error: vi.fn(),
    exit: exitWithCode,
  }).catch((error: unknown) => error);
}

describe("onboarding command failures", () => {
  it("redacts nested causes without replacing the errors or their recovery diagnostics", async () => {
    const secret = `nvapi-${"b".repeat(60)}`;
    const leaf = new Error(`Provider failed: ${secret}`);
    leaf.stack = `Provider stack: ${secret}`;
    const cause = new Error("Retry after correcting permissions.", { cause: leaf });
    const failure = new Error("Onboarding failed", { cause });

    await rethrowOnboardFailure(failure);

    expect(failure.cause).toBe(cause);
    expect(cause.cause).toBe(leaf);
    expect(leaf.message).toBe("Provider failed: <REDACTED>");
    expect(leaf.stack).not.toContain(secret);
    expect(leaf.stack).toContain("<REDACTED>");
    expect(cause.message).toBe("Retry after correcting permissions.");
    expect(inspect(failure, { depth: null })).not.toContain(secret);
    expect(String(failure)).toBe("[REDACTED ERROR]");
  });

  it("redacts nested aggregate members and causes before structured rendering", async () => {
    const secret = `nvapi-${"c".repeat(60)}`;
    const pem = [
      "-----BEGIN " + "PRIVATE KEY-----",
      "synthetic-key-payload",
      "-----END " + "PRIVATE KEY-----",
    ].join("\n");
    const primary = new Error(`Primary failure: ${secret}`, { cause: new Error(pem) });
    primary.stack = `Primary stack: ${secret}`;
    const rollback = new Error("Rollback failed");
    rollback.stack = `Rollback stack: ${secret}`;
    const nested = new AggregateError([rollback], "Recovery failed");
    const failure = new AggregateError([primary, nested], "Onboarding failed", { cause: primary });
    const members = failure.errors;

    await rethrowOnboardFailure(failure);

    expect(failure.errors).toBe(members);
    expect(failure.errors[0]).toBe(primary);
    expect(failure.errors[1]).toBe(nested);
    expect(nested.errors[0]).toBe(rollback);
    expect(failure.cause).toBe(primary);
    expect(primary.message).toBe("Primary failure: <REDACTED>");
    expect(primary.stack).not.toContain(secret);
    expect(primary.stack).toContain("<REDACTED>");
    expect(rollback.stack).not.toContain(secret);
    expect(rollback.stack).toContain("<REDACTED>");
    const rendered = inspect(failure, { depth: null });
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("synthetic-key-payload");
    expect(rendered).not.toContain("PRIVATE KEY");
  });

  it("redacts shared cyclic error graphs without replacing links or suppressing failure", async () => {
    const secret = `nvapi-${"d".repeat(60)}`;
    const leaf = new Error(`Nested failure: ${secret}`);
    const failure = new AggregateError([leaf, leaf], "Onboarding failed", { cause: leaf });
    leaf.cause = failure;
    failure.errors.push(failure);

    await rethrowOnboardFailure(failure);

    expect(leaf.cause).toBe(failure);
    expect(failure.cause).toBe(leaf);
    expect(failure.errors).toEqual([leaf, leaf, failure]);
    expect(leaf.message).toBe("Nested failure: <REDACTED>");
    expect(inspect(failure, { depth: null })).not.toContain(secret);
  });

  it("redacts custom error diagnostics without invoking accessors", async () => {
    const directSecret = `nvapi-${"g".repeat(60)}`;
    const nestedSecret = `nvapi-${"h".repeat(60)}`;
    const member = new Error("Member failed") as Error & {
      diagnostic?: unknown;
    };
    member.diagnostic = directSecret;
    const failure = new AggregateError([member], "Onboarding failed") as AggregateError & {
      context?: unknown;
      lazyDiagnostic?: unknown;
    };
    const context: Record<string, unknown> = {
      nested: { credential: nestedSecret },
    };
    context.failure = failure;
    failure.context = context;
    const accessor = vi.fn(() => nestedSecret);
    Object.defineProperty(failure, "lazyDiagnostic", {
      configurable: true,
      enumerable: true,
      get: accessor,
    });
    const members = failure.errors;

    await rethrowOnboardFailure(failure);

    expect(failure.errors).toBe(members);
    expect(failure.errors[0]).toBe(member);
    expect(accessor).not.toHaveBeenCalled();
    expect((failure.context as Record<string, unknown>).failure).toBe(failure);
    const rendered = inspect(failure, { depth: null });
    expect(rendered).not.toContain(directSecret);
    expect(rendered).not.toContain(nestedSecret);
    expect(rendered).toContain("<REDACTED>");
    expect(accessor).not.toHaveBeenCalled();
  });

  it("neutralizes a throwing stack accessor without invoking it", async () => {
    const secret = `nvapi-${"i".repeat(60)}`;
    const failure = new Error("Onboarding failed");
    const stackAccessor = vi.fn(() => {
      throw new Error(secret);
    });
    Object.defineProperty(failure, "stack", {
      configurable: true,
      get: stackAccessor,
    });

    await rethrowOnboardFailure(failure);

    expect(stackAccessor).not.toHaveBeenCalled();
    expect(failure.stack).toBe("<REDACTED>");
  });

  it("neutralizes a custom structured-inspection function without invoking it", async () => {
    const secret = `nvapi-${"j".repeat(60)}`;
    const failure = new Error("Onboarding failed");
    const customInspect = vi.fn(() => `Leaked diagnostic: ${secret}`);
    Object.defineProperty(failure, inspect.custom, {
      configurable: true,
      value: customInspect,
      writable: true,
    });

    await rethrowOnboardFailure(failure);

    expect(customInspect).not.toHaveBeenCalled();
    expect(inspect(failure, { depth: null })).not.toContain(secret);
    expect(customInspect).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(failure, inspect.custom)?.value).toBeUndefined();
  });

  it("neutralizes an inherited structured-inspection function without invoking it", async () => {
    const secret = `nvapi-${"p".repeat(60)}`;
    const customInspect = vi.fn(() => `Leaked diagnostic: ${secret}`);
    class StructuredError extends Error {}
    Object.defineProperty(StructuredError.prototype, inspect.custom, {
      configurable: true,
      value: customInspect,
    });
    const failure = new StructuredError("Onboarding failed");
    Object.preventExtensions(failure);

    const caught = await catchOnboardFailure(failure);

    expect(customInspect).not.toHaveBeenCalled();
    expect(caught).not.toBe(failure);
    expect(inspect(caught, { depth: null })).not.toContain(secret);
    expect(customInspect).not.toHaveBeenCalled();
  });

  it("neutralizes own and inherited JSON renderers without invoking them", async () => {
    const ownSecret = `nvapi-${"q".repeat(60)}`;
    const inheritedSecret = `nvapi-${"r".repeat(60)}`;
    const ownRenderer = vi.fn(() => ({ credential: ownSecret }));
    const inheritedRenderer = vi.fn(() => ({ credential: inheritedSecret }));
    class JsonError extends Error {}
    Object.defineProperty(JsonError.prototype, "toJSON", {
      configurable: true,
      value: inheritedRenderer,
    });
    const nested = new JsonError("Nested failure");
    const failure = new Error("Onboarding failed", { cause: nested });
    Object.defineProperty(failure, "toJSON", {
      configurable: true,
      value: ownRenderer,
      writable: true,
    });

    await rethrowOnboardFailure(failure);

    expect(ownRenderer).not.toHaveBeenCalled();
    expect(inheritedRenderer).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain(ownSecret);
    expect(JSON.stringify(nested)).not.toContain(inheritedSecret);
    expect(ownRenderer).not.toHaveBeenCalled();
    expect(inheritedRenderer).not.toHaveBeenCalled();
  });

  it("neutralizes an inherited toString hook without invoking it", async () => {
    const secret = `nvapi-${"w".repeat(60)}`;
    const toString = vi.fn(() => `Leaked diagnostic: ${secret}`);
    class CoercionError extends Error {}
    Object.defineProperty(CoercionError.prototype, "toString", {
      configurable: true,
      value: toString,
    });
    const failure = new CoercionError("Onboarding failed");

    await rethrowOnboardFailure(failure);

    expect(toString).not.toHaveBeenCalled();
    expect(String(failure)).toBe("[REDACTED ERROR]");
    expect(String(failure)).not.toContain(secret);
    expect(toString).not.toHaveBeenCalled();
  });

  it("neutralizes an inherited Symbol.toPrimitive hook without invoking it", async () => {
    const secret = `nvapi-${"x".repeat(60)}`;
    const toPrimitive = vi.fn(() => `Leaked diagnostic: ${secret}`);
    class PrimitiveError extends Error {}
    Object.defineProperty(PrimitiveError.prototype, Symbol.toPrimitive, {
      configurable: true,
      value: toPrimitive,
    });
    const failure = new PrimitiveError("Onboarding failed");
    Object.preventExtensions(failure);

    const caught = await catchOnboardFailure(failure);

    expect(toPrimitive).not.toHaveBeenCalled();
    expect(caught).not.toBe(failure);
    expect(String(caught)).toBe("[REDACTED ERROR]");
    expect(String(caught)).not.toContain(secret);
    expect(toPrimitive).not.toHaveBeenCalled();
  });

  it("neutralizes an inherited valueOf hook before numeric coercion", async () => {
    const secret = `nvapi-${"y".repeat(60)}`;
    const valueOf = vi.fn(() => `1${secret}`);
    class NumericError extends Error {}
    Object.defineProperty(NumericError.prototype, "valueOf", {
      configurable: true,
      value: valueOf,
    });
    const failure = new NumericError("Onboarding failed");

    await rethrowOnboardFailure(failure);

    expect(valueOf).not.toHaveBeenCalled();
    expect(Number(failure)).toBeNaN();
    expect(valueOf).not.toHaveBeenCalled();
  });

  it("does not consult inherited name or message getters during string coercion", async () => {
    const secret = `nvapi-${"1".repeat(60)}`;
    const name = vi.fn(() => `Name ${secret}`);
    const message = vi.fn(() => `Message ${secret}`);
    class GetterError extends Error {}
    Object.defineProperties(GetterError.prototype, {
      name: { configurable: true, get: name },
      message: { configurable: true, get: message },
    });
    const failure = new GetterError();

    await rethrowOnboardFailure(failure);

    expect(name).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    expect(String(failure)).toBe("[REDACTED ERROR]");
    expect(String(failure)).not.toContain(secret);
    expect(name).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it("does not consult an inherited Symbol.toStringTag getter during coercion", async () => {
    const secret = `nvapi-${"2".repeat(60)}`;
    const toStringTag = vi.fn(() => `Tag ${secret}`);
    class TaggedError extends Error {}
    Object.defineProperty(TaggedError.prototype, Symbol.toStringTag, {
      configurable: true,
      get: toStringTag,
    });
    const failure = new TaggedError("Onboarding failed");

    await rethrowOnboardFailure(failure);

    expect(toStringTag).not.toHaveBeenCalled();
    expect(String(failure)).toBe("[REDACTED ERROR]");
    expect(String(failure)).not.toContain(secret);
    expect(toStringTag).not.toHaveBeenCalled();
  });

  it("does not trust a poisoned Error prototype captured during module import", async () => {
    const secret = `nvapi-${"3".repeat(60)}`;
    const poisonedToString = vi.fn(() => `Leaked diagnostic: ${secret}`);
    const original = Object.getOwnPropertyDescriptor(Error.prototype, "toString");
    assert(original);
    Object.defineProperty(Error.prototype, "toString", {
      ...original,
      value: poisonedToString,
    });
    try {
      vi.resetModules();
      const { redactOnboardError } = await import("./diagnostics/redaction");
      const failure = redactOnboardError(new Error("Onboarding failed"));

      expect(poisonedToString).not.toHaveBeenCalled();
      expect(String(failure)).toBe("[REDACTED ERROR]");
      expect(String(failure)).not.toContain(secret);
      expect(poisonedToString).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Error.prototype, "toString", original);
      vi.resetModules();
    }
  });

  it("fails closed when an own coercion hook is immutable", async () => {
    const secret = `nvapi-${"z".repeat(60)}`;
    const toString = vi.fn(() => `Leaked diagnostic: ${secret}`);
    const failure = new Error("Onboarding failed");
    Object.defineProperty(failure, "toString", {
      configurable: false,
      value: toString,
      writable: false,
    });

    const caught = await catchOnboardFailure(failure);

    expect(caught).not.toBe(failure);
    expect(toString).not.toHaveBeenCalled();
    expect(String(caught)).toBe("[REDACTED ERROR]");
    expect(String(caught)).not.toContain(secret);
    expect(toString).not.toHaveBeenCalled();
  });

  it("fails closed when a diagnostic function name contains a secret", async () => {
    const secret = `nvapi-${"s".repeat(60)}`;
    const diagnostic = { [secret]: () => undefined }[secret];
    const failure = new Error("Onboarding failed") as Error & { diagnostic?: unknown };
    failure.diagnostic = diagnostic;
    expect(inspect(diagnostic)).toContain(secret);

    const caught = await catchOnboardFailure(failure);

    expect(caught).not.toBe(failure);
    expect(inspect(caught, { depth: null })).not.toContain(secret);
  });

  it("fails closed when a diagnostic symbol value contains a secret", async () => {
    const secret = `nvapi-${"t".repeat(60)}`;
    const diagnostic = Symbol(secret);
    const failure = new Error("Onboarding failed") as Error & { diagnostic?: unknown };
    failure.diagnostic = diagnostic;
    expect(inspect(diagnostic)).toContain(secret);

    const caught = await catchOnboardFailure(failure);

    expect(caught).not.toBe(failure);
    expect(inspect(caught, { depth: null })).not.toContain(secret);
  });

  it("fails closed when string or symbol diagnostic property keys contain secrets", async () => {
    const stringSecret = `nvapi-${"u".repeat(60)}`;
    const symbolSecret = `nvapi-${"v".repeat(60)}`;
    const failure = new Error("Onboarding failed") as Error & Record<string, unknown>;
    failure[stringSecret] = "diagnostic";
    expect(inspect(failure, { depth: null })).toContain(stringSecret);
    const symbolFailure = new Error("Onboarding failed");
    Object.defineProperty(symbolFailure, Symbol(symbolSecret), { value: "diagnostic" });
    expect(inspect(symbolFailure, { depth: null, showHidden: true })).toContain(symbolSecret);

    const caught = await catchOnboardFailure(failure);
    const symbolCaught = await catchOnboardFailure(symbolFailure);

    expect(caught).not.toBe(failure);
    expect(symbolCaught).not.toBe(symbolFailure);
    expect(inspect(caught, { depth: null })).not.toContain(stringSecret);
    expect(inspect(symbolCaught, { depth: null, showHidden: true })).not.toContain(symbolSecret);
  });

  it("returns an opaque fallback without partially rewriting immutable error data", async () => {
    const messageSecret = `nvapi-${"k".repeat(60)}`;
    const immutableSecret = `nvapi-${"l".repeat(60)}`;
    const originalMessage = `Onboarding failed: ${messageSecret}`;
    const failure = new Error(originalMessage);
    Object.defineProperty(failure, "diagnostic", {
      configurable: false,
      enumerable: true,
      value: immutableSecret,
      writable: false,
    });

    const caught = await catchOnboardFailure(failure);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(failure);
    expect(inspect(caught, { depth: null })).not.toContain(messageSecret);
    expect(inspect(caught, { depth: null })).not.toContain(immutableSecret);
    expect(failure.message).toBe(originalMessage);
  });

  it("returns an opaque fallback for immutable aggregate members", async () => {
    const secret = `nvapi-${"m".repeat(60)}`;
    const failure = new AggregateError([secret], "Onboarding failed");
    Object.freeze(failure.errors);

    const caught = await catchOnboardFailure(failure);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(failure);
    expect(inspect(caught, { depth: null })).not.toContain(secret);
    expect(failure.errors).toEqual([secret]);
  });

  it("returns an opaque fallback for an unsupported nested diagnostic container", async () => {
    const secret = `nvapi-${"o".repeat(60)}`;
    const failure = new Error("Onboarding failed") as Error & { context?: unknown };
    failure.context = new (class DiagnosticContext {
      readonly credential = secret;
    })();

    const caught = await catchOnboardFailure(failure);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(failure);
    expect(inspect(caught, { depth: null })).not.toContain(secret);
  });

  it("attaches the returned fallback for an immutable rollback diagnostic", () => {
    const secret = `nvapi-${"n".repeat(60)}`;
    const failure = new Error("Managed bootstrap failed") as Error & {
      managedBootstrapRollbackError?: unknown;
    };
    const rollback = new Error("Rollback failed");
    Object.defineProperty(rollback, "diagnostic", {
      configurable: false,
      value: secret,
      writable: false,
    });

    attachManagedBootstrapRollbackError(failure, rollback);

    expect(failure.managedBootstrapRollbackError).toBeInstanceOf(Error);
    expect(failure.managedBootstrapRollbackError).not.toBe(rollback);
    expect(inspect(failure, { depth: null })).not.toContain(secret);
  });

  it("redacts managed bootstrap rollback diagnostics before rethrow", async () => {
    const secret = `nvapi-${"f".repeat(60)}`;
    const rollback = new Error(`Rollback failed: ${secret}`);
    rollback.stack = `Rollback stack: ${secret}`;
    const failure = new Error("Managed bootstrap failed") as Error & {
      managedBootstrapRollbackError?: unknown;
    };
    failure.managedBootstrapRollbackError = rollback;
    rollback.cause = failure;

    await rethrowOnboardFailure(failure);

    expect(failure.managedBootstrapRollbackError).toBe(rollback);
    expect(rollback.cause).toBe(failure);
    expect(rollback.message).toBe("Rollback failed: <REDACTED>");
    expect(rollback.stack).not.toContain(secret);
    expect(rollback.stack).toContain("<REDACTED>");
    expect(inspect(failure, { depth: null })).not.toContain(secret);
  });

  it("redacts string causes and aggregate members while retaining non-string values", async () => {
    const secret = `nvapi-${"e".repeat(60)}`;
    const failure = new AggregateError([secret, null, 42], "Onboarding failed", { cause: secret });
    const members = failure.errors;

    await rethrowOnboardFailure(failure);

    expect(failure.cause).toBe("<REDACTED>");
    expect(failure.errors).toBe(members);
    expect(members).toEqual(["<REDACTED>", null, 42]);
  });

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
    expect(failure.stack).toContain("<REDACTED>");
  });

  it("redacts credential strings nested in plain diagnostic objects without following cycles", async () => {
    const payload = "plain-object-key-payload".repeat(20);
    const pem = [
      "-----BEGIN " + "PRIVATE KEY-----",
      payload,
      "-----END " + "PRIVATE KEY-----",
    ].join("\n");
    const details: Record<string, unknown> = {
      diagnostic: `Nested failure\n${pem}\nInspect the rejected credential.`,
    };
    details.self = details;
    const failure = new AggregateError([details], "Onboarding cleanup failed", {
      cause: details,
    });

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

    const redacted = failure.cause as Record<string, unknown>;
    expect(failure.errors[0]).toBe(redacted);
    expect(redacted.self).toBe(redacted);
    expect(String(redacted.diagnostic)).not.toContain(payload);
    expect(String(redacted.diagnostic)).not.toContain("PRIVATE KEY");
    expect(String(redacted.diagnostic)).toContain("<REDACTED>");
    expect(String(redacted.diagnostic)).toContain("Inspect the rejected credential.");
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
