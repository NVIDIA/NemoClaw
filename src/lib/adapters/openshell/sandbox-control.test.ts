// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CaptureOpenshellResult } from "./client";
import {
  createCliOpenShellSandboxControl,
  createGatewayScopedCliOpenShellSandboxControl,
} from "./sandbox-control";

describe("CLI OpenShell sandbox control", () => {
  it("maps a typed exec request to the existing CLI contract", async () => {
    const capture = vi.fn(
      (): CaptureOpenshellResult => ({
        status: 0,
        output: "hello",
        stdout: "hello\n",
        stderr: "warning\n",
      }),
    );
    const control = createCliOpenShellSandboxControl(capture);

    const result = await control.exec({
      sandboxName: "alpha",
      command: ["openclaw", "sessions", "list", "--json"],
      maxOutputBytes: 4096,
      timeoutMs: 30_000,
    });

    expect(capture).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "sessions", "list", "--json"],
      { ignoreError: true, includeStreams: true, maxBuffer: 4096, timeout: 30_000 },
    );
    expect(result).toEqual({
      status: 0,
      stdout: "hello\n",
      stderr: "warning\n",
    });
  });

  it("preserves transport failures without throwing", async () => {
    const error = Object.assign(new Error("spawnSync openshell ENOBUFS"), { code: "ENOBUFS" });
    const capture = vi.fn(
      (): CaptureOpenshellResult => ({
        status: null,
        output: "partial",
        error,
        signal: "SIGTERM",
      }),
    );
    const control = createCliOpenShellSandboxControl(capture);

    await expect(control.exec({ sandboxName: "alpha", command: ["true"] })).resolves.toEqual({
      status: null,
      stdout: "partial",
      stderr: "",
      error,
      signal: "SIGTERM",
    });
  });

  it("pins fallback execution to the requested gateway", async () => {
    const capture = vi.fn(
      (): CaptureOpenshellResult => ({
        status: 0,
        output: "ok",
      }),
    );
    const control = createGatewayScopedCliOpenShellSandboxControl("nemoclaw-19080", capture, {});

    await control.exec({ sandboxName: "alpha", command: ["true"] });

    expect(capture).toHaveBeenCalledWith(
      ["--gateway", "nemoclaw-19080", "sandbox", "exec", "--name", "alpha", "--", "true"],
      expect.objectContaining({ ignoreError: true, includeStreams: true }),
    );
  });

  it("rejects an ambient endpoint that could override the fallback gateway", () => {
    const capture = vi.fn<() => CaptureOpenshellResult>();

    expect(() =>
      createGatewayScopedCliOpenShellSandboxControl("nemoclaw-19080", capture, {
        OPENSHELL_GATEWAY_ENDPOINT: "https://other.example.test",
      }),
    ).toThrow(/Unset OPENSHELL_GATEWAY_ENDPOINT/);
    expect(capture).not.toHaveBeenCalled();
  });
});
