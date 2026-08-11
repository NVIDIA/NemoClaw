// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createContainerEngineCommand } from "./container-engine";

describe("operation-scoped container engine command", () => {
  it("binds endpoint arguments without changing host-only commands", () => {
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createContainerEngineCommand({
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      endpointArgs: ["--url", "unix:///runtime/podman.sock"],
      capture,
    });

    expect(engine.capture(["container", "inspect", "abc"], 1234)).toEqual({
      status: 0,
      stdout: "ok",
      stderr: "",
    });
    engine.captureHost(["unshare", "cat", "/proc/self/uid_map"], 2345);

    expect(capture.mock.calls).toEqual([
      ["podman", ["--url", "unix:///runtime/podman.sock", "container", "inspect", "abc"], 1234],
      ["podman", ["unshare", "cat", "/proc/self/uid_map"], 2345],
    ]);
    expect(Object.isFrozen(engine)).toBe(true);
  });

  it("keeps separately scoped engines isolated", () => {
    const doctorCapture = vi.fn(() => ({ status: 0, stdout: "doctor", stderr: "" }));
    const lifecycleCapture = vi.fn(() => ({ status: 0, stdout: "lifecycle", stderr: "" }));
    const doctor = createContainerEngineCommand({
      operation: "host-doctor",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:doctor",
      executable: "podman-doctor",
      capture: doctorCapture,
    });
    const lifecycle = createContainerEngineCommand({
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:lifecycle",
      executable: "podman-lifecycle",
      capture: lifecycleCapture,
    });

    expect(doctor.capture(["info"]).stdout).toBe("doctor");
    expect(lifecycle.capture(["start", "abc"]).stdout).toBe("lifecycle");
    expect(doctorCapture).toHaveBeenCalledExactlyOnceWith("podman-doctor", ["info"], 15_000);
    expect(lifecycleCapture).toHaveBeenCalledExactlyOnceWith(
      "podman-lifecycle",
      ["start", "abc"],
      15_000,
    );
  });

  it("forwards bounded binary stdin to one endpoint-scoped command", () => {
    const capture = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const engine = createContainerEngineCommand({
      operation: "managed-bootstrap",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      endpointArgs: ["--url", "unix:///runtime/podman.sock"],
      capture,
    });
    const archive = Buffer.from("archive");

    engine.capture(["container", "cp", "-", "abc:/"], 2_345, archive);

    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "podman",
      ["--url", "unix:///runtime/podman.sock", "container", "cp", "-", "abc:/"],
      2_345,
      archive,
    );
    expect(() => engine.capture(["info"], 1_000, Buffer.alloc(1024 * 1024 + 1))).toThrow(
      "exceeds its byte bound",
    );
  });

  it("guards before and after commands while preserving command failures", () => {
    const commandFailure = new Error("command failed");
    const guardFailure = new Error("authority changed");
    const guard = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw guardFailure;
      });
    const engine = createContainerEngineCommand({
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      capture: () => {
        throw commandFailure;
      },
      guard,
    });

    expect(() => engine.capture(["stop", "abc"])).toThrow(commandFailure);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("rejects endpoint rotation observed after a successful command", () => {
    const authorityChanged = new Error("authority changed");
    const guard = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw authorityChanged;
      });
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    const engine = createContainerEngineCommand({
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      capture,
      guard,
    });

    expect(() => engine.capture(["start", "a".repeat(64)])).toThrow(authorityChanged);
    expect(capture).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid identities, timeouts, and command arguments before capture", () => {
    const capture = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    expect(() =>
      createContainerEngineCommand({
        operation: "host-doctor",
        engineId: "Podman",
        displayName: "Podman",
        authorityId: "test:podman-socket",
        executable: "podman",
      }),
    ).toThrow("identity is invalid");
    expect(() =>
      createContainerEngineCommand({
        operation: "host-doctor",
        engineId: "podman",
        displayName: "Podman",
        authorityId: "unsafe/socket",
        executable: "podman",
      }),
    ).toThrow("authority identity is invalid");
    const engine = createContainerEngineCommand({
      operation: "host-doctor",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      capture,
    });
    expect(() => engine.capture(["info"], 0)).toThrow("positive safe integer");
    expect(() => engine.capture(["bad\0argument"])).toThrow("arguments[0] is invalid");
    expect(capture).not.toHaveBeenCalled();
  });
});
