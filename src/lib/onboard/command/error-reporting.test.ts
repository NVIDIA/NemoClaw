// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { pendingStdinEofError } from "../../core/pending-stdin-eof";
import { handleOnboardCommandError } from "./error-reporting";

it("reports nested onboarding causes without replacing the failure", () => {
  const primary = new Error("Created sandbox identity changed");
  const nested = new AggregateError(
    [primary, new Error("Recovery record retained")],
    "Cleanup failed",
  );
  const failure = new AggregateError([nested], "Onboarding finalization failed");
  const error = vi.fn();
  expect(() => handleOnboardCommandError(failure, { error }, null)).toThrow(failure);
  expect(error.mock.calls.flat()).toEqual([
    "  Onboarding cause: Cleanup failed",
    "  Onboarding cause: Created sandbox identity changed",
    "  Onboarding cause: Recovery record retained",
  ]);
});

it("bounds repeated and cyclic causes and redacts secrets before truncation", () => {
  const secret = `nvapi-${"s".repeat(60)}`;
  const leaf = new Error(`Authorization: Bearer ${secret}\n${"x".repeat(1000)}`);
  const failure = new AggregateError(
    [leaf, leaf, ...Array.from({ length: 20 }, () => leaf)],
    "Failed",
  );
  leaf.cause = failure;
  const error = vi.fn();
  expect(() => handleOnboardCommandError(failure, { error }, null)).toThrow(failure);
  expect(error).toHaveBeenCalledTimes(1);
  const output = error.mock.calls[0]![0] as string;
  expect(output).not.toContain(secret);
  expect(output).not.toContain("\n");
  expect(output.length).toBeLessThanOrEqual(260);
  const many = new AggregateError(
    Array.from({ length: 20 }, (_, i) => new Error(`Cause ${i}`)),
    "Failed",
  );
  error.mockClear();
  expect(() => handleOnboardCommandError(many, { error }, null)).toThrow(many);
  expect(error).toHaveBeenCalledTimes(8);
});

it("does not invoke diagnostic accessors or let a broken sink replace the failure", () => {
  const access = vi.fn(() => "must not execute");
  const member = Object.defineProperty({}, "message", { get: access });
  const failure = new AggregateError([member, new Error("Primary error")], "Failed");
  const error = vi.fn(() => {
    throw new Error("Sink failed");
  });
  expect(() => handleOnboardCommandError(failure, { error }, null)).toThrow(failure);
  expect(access).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledTimes(1);
});

it("keeps cancellation and ordinary failure output unchanged", () => {
  const error = vi.fn();
  const failure = new Error("Ordinary failure");
  expect(() => handleOnboardCommandError(failure, { error }, null)).toThrow(failure);
  expect(handleOnboardCommandError(failure, { error }, "SIGINT")).toBeNull();
  expect(error).not.toHaveBeenCalled();
  expect(handleOnboardCommandError(failure, { error }, "EOF")).toBe(1);
  expect(error).toHaveBeenCalledExactlyOnceWith("  Installation cancelled");
});

it("reports a wrapped prompt-EOF cancellation as Installation cancelled (#13910)", () => {
  // The messaging-channel selector's Ctrl-D rejection traverses the whole
  // onboard unwind. A layer that wraps the step failure must not degrade the
  // deliberate cancellation into the generic unfinished-run failure path.
  const wrapped = new Error("Messaging channel setup failed", {
    cause: pendingStdinEofError(),
  });
  const error = vi.fn();
  expect(handleOnboardCommandError(wrapped, { error }, null)).toBe(1);
  expect(error).toHaveBeenCalledExactlyOnceWith("  Installation cancelled");
});

it("recovers a wrapped EOF cancellation nested inside aggregate failures (#13910)", () => {
  const wrapped = new AggregateError(
    [new Error("Channel manifest failed"), pendingStdinEofError()],
    "Messaging channel setup failed",
  );
  const error = vi.fn();
  expect(handleOnboardCommandError(wrapped, { error }, null)).toBe(1);
  expect(error).toHaveBeenCalledExactlyOnceWith("  Installation cancelled");
});

it("keeps an ordinary wrapped failure out of the cancellation path (#13910)", () => {
  const wrapped = new Error("Messaging channel setup failed", {
    cause: new Error("docker build failed"),
  });
  const error = vi.fn();
  expect(() => handleOnboardCommandError(wrapped, { error }, null)).toThrow(wrapped);
  expect(error).toHaveBeenCalledExactlyOnceWith("  Onboarding cause: docker build failed");
});
