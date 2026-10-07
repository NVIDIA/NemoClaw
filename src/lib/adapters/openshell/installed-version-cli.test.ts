// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellInstalledVersionObserver } from "./installed-version-cli";

function result(overrides: Record<string, unknown> = {}) {
  return { error: undefined, status: 0, stderr: "", stdout: "openshell 0.0.116\n", ...overrides };
}

describe("CLI OpenShell installed-version observer (#11832)", () => {
  it("captures a bounded version probe with a filtered environment", () => {
    const capture = vi.fn(() => result());
    const observer = createCliOpenShellInstalledVersionObserver({
      capture,
      environment: {
        HOME: "/fixture/home",
        PATH: "/fixture/bin",
        NVIDIA_INFERENCE_API_KEY: "nvapi-fixture-secret",
      },
      hostCwd: "/fixture/repo",
      resolveBinary: () => "/fixture/bin/openshell",
    });

    expect(observer.observeInstalledVersion()).toEqual({ ok: true, version: "0.0.116" });
    expect(capture).toHaveBeenCalledExactlyOnceWith("/fixture/bin/openshell", ["-V"], {
      cwd: "/fixture/repo",
      encoding: "utf8",
      env: { HOME: "/fixture/home", PATH: "/fixture/bin" },
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain("nvapi-fixture-secret");
  });

  it("returns unavailable without starting a process when resolution fails", () => {
    const capture = vi.fn();
    const observer = createCliOpenShellInstalledVersionObserver({
      capture,
      resolveBinary: () => null,
    });

    expect(observer.observeInstalledVersion()).toMatchObject({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects invalid timeouts and relative binaries before execution", () => {
    const capture = vi.fn();
    const invalidTimeout = createCliOpenShellInstalledVersionObserver({
      capture,
      resolveBinary: () => "/fixture/openshell",
    });
    const relativeBinary = createCliOpenShellInstalledVersionObserver({
      capture,
      resolveBinary: () => "openshell",
    });

    expect(invalidTimeout.observeInstalledVersion({ timeoutMs: 0 })).toMatchObject({
      ok: false,
      error: { kind: "configuration" },
    });
    expect(relativeBinary.observeInstalledVersion()).toMatchObject({
      ok: false,
      error: { kind: "configuration" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })],
    ["capture", Object.assign(new Error("too much output"), { code: "ENOBUFS" })],
    ["invocation", Object.assign(new Error("permission denied"), { code: "EACCES" })],
  ] as const)("maps a %s failure", (kind, error) => {
    const observer = createCliOpenShellInstalledVersionObserver({
      capture: () => result({ error, status: null }),
      resolveBinary: () => "/fixture/openshell",
    });

    expect(observer.observeInstalledVersion()).toMatchObject({ ok: false, error: { kind } });
  });

  it("rejects malformed and unsuccessful version output", () => {
    const malformed = createCliOpenShellInstalledVersionObserver({
      capture: () => result({ stdout: "unknown build" }),
      resolveBinary: () => "/fixture/openshell",
    });
    const failed = createCliOpenShellInstalledVersionObserver({
      capture: () => result({ status: 1, stderr: "TOKEN=fixture-secret" }),
      resolveBinary: () => "/fixture/openshell",
    });

    expect(malformed.observeInstalledVersion()).toMatchObject({
      ok: false,
      error: { kind: "malformed" },
    });
    const failure = failed.observeInstalledVersion();
    expect(failure).toMatchObject({ ok: false, error: { kind: "invocation" } });
    expect(JSON.stringify(failure)).not.toContain("fixture-secret");
  });

  it.each(["unrelated tool 0.0.116", "openshell-gateway 9.9.9", "not-openshell 8.8.8"])(
    "does not accept a version from another executable: %s",
    (stdout) => {
      const observer = createCliOpenShellInstalledVersionObserver({
        capture: () => result({ stdout }),
        resolveBinary: () => "/fixture/openshell",
      });

      expect(observer.observeInstalledVersion()).toMatchObject({
        ok: false,
        error: { kind: "malformed" },
      });
    },
  );
});
