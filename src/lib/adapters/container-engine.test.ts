// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "./container-engine";

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
      allowedEnvironmentNames: ["NEMOCLAW_TEST_API_KEY"],
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
    expect(engine.endpointAuthorityId).toBe(engine.authorityId);
  });

  it("separates a shared endpoint identity from a stricter operation authority", () => {
    const engine = createContainerEngineCommand({
      operation: "host-local-inference",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:socket-and-executable",
      endpointAuthorityId: "test:socket",
      executable: "/usr/bin/podman",
      capture: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    });

    expect(engine).toMatchObject({
      authorityId: "test:socket-and-executable",
      endpointAuthorityId: "test:socket",
    });
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

  it("exposes bounded explicit environment only to host-local inference", () => {
    const capture = vi.fn<ContainerEngineCommandCapture>(() => ({
      status: 0,
      stdout: "ok",
      stderr: "",
    }));
    const engine = createContainerEngineCommand({
      operation: "host-local-inference",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      endpointArgs: ["--url", "unix:///runtime/podman.sock"],
      allowedEnvironmentNames: ["NEMOCLAW_TEST_API_KEY"],
      capture,
    });
    const explicit = Object.freeze({ NEMOCLAW_TEST_API_KEY: "operation-only-test-value" });
    const processValueBefore = process.env.NEMOCLAW_TEST_API_KEY;

    expect(
      engine.captureWithEnvironment?.(["run", "--env", "NEMOCLAW_TEST_API_KEY"], explicit, 1234),
    ).toMatchObject({ status: 0 });
    expect(process.env.NEMOCLAW_TEST_API_KEY).toBe(processValueBefore);
    expect(explicit).toEqual({ NEMOCLAW_TEST_API_KEY: "operation-only-test-value" });
    expect(capture).toHaveBeenCalledOnce();
    const invocationEnvironment = capture.mock.calls[0]?.[4];
    expect(invocationEnvironment).toMatchObject({
      NEMOCLAW_TEST_API_KEY: "operation-only-test-value",
      PATH: process.env.PATH,
    });
    expect(invocationEnvironment).not.toBe(explicit);
    expect(Object.isFrozen(invocationEnvironment)).toBe(true);
  });

  it("does not expose environment capture to other operation scopes", () => {
    const engine = createContainerEngineCommand({
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      capture: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    });

    expect(engine.captureWithEnvironment).toBeUndefined();
  });

  it("replaces the ambient environment for one authority-bound operation", () => {
    const capture = vi.fn<ContainerEngineCommandCapture>(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const commandEnvironment = Object.freeze({
      HOME: "/home/receipt",
      XDG_CONFIG_HOME: "/home/receipt/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    const engine = createContainerEngineCommand({
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "/usr/bin/podman",
      commandEnvironment,
      capture,
    });

    engine.capture(["container", "inspect", "abc"]);

    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/podman",
      ["container", "inspect", "abc"],
      15_000,
      undefined,
      commandEnvironment,
    );
    expect(capture.mock.calls[0]?.[4]).not.toHaveProperty("HTTP_PROXY");
    expect(capture.mock.calls[0]?.[4]).not.toHaveProperty("DOCKER_HOST");
  });

  it("rejects unsafe or unbounded operation environments before capture", () => {
    const capture = vi.fn<ContainerEngineCommandCapture>(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const engine = createContainerEngineCommand({
      operation: "host-local-inference",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test:podman-socket",
      executable: "podman",
      allowedEnvironmentNames: ["NGC_API_KEY"],
      capture,
    });

    expect(() => engine.captureWithEnvironment?.(["run"], { PATH: "/untrusted" })).toThrow(
      "name is invalid or reserved",
    );
    expect(() => engine.captureWithEnvironment?.(["run"], { NGC_API_KEY: "" })).toThrow(
      "value is invalid",
    );
    expect(() => engine.captureWithEnvironment?.(["run"], { LD_PRELOAD: "/tmp/hook.so" })).toThrow(
      "name is invalid or reserved",
    );
    expect(() => engine.captureWithEnvironment?.(["run"], { NIM_NGC_API_KEY: "secret" })).toThrow(
      "name is invalid or reserved",
    );
    expect(() =>
      engine.captureWithEnvironment?.(
        ["run"],
        Object.fromEntries(
          Array.from({ length: 33 }, (_value, index) => [`SECRET_${String(index)}`, "value"]),
        ),
      ),
    ).toThrow("too many entries");
    expect(capture).not.toHaveBeenCalled();
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
