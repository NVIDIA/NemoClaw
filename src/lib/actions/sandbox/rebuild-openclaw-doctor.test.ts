// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildOpenClawPostUpgradeDoctorMarkerCommand,
  runOpenClawPostRestoreDoctor,
} from "./process-recovery";

describe("OpenClaw rebuild doctor restart", () => {
  it("publishes an owner-only one-shot marker atomically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-marker-"));
    try {
      const command = buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll(
        "/sandbox/.openclaw",
        root,
      );
      execFileSync("bash", ["-c", command]);

      const marker = path.join(root, ".nemoclaw-post-upgrade-doctor");
      expect(fs.readFileSync(marker, "utf8")).toBe("nemoclaw-openclaw-post-upgrade-doctor-v1\n");
      expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restarts through the pinned runtime and verifies marker consumption plus health", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 21, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
    const capture = vi.fn((_args: readonly string[], _options: Record<string, unknown>) => ({
      status: 0,
      output: "",
    }));
    const sleep = vi.fn(async () => undefined);
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default" as const,
      localTlsDir: "/authority/tls",
    };

    await expect(
      runOpenClawPostRestoreDoctor("alpha", runtimeSelection, {
        captureOpenshell: capture as never,
        executeSandboxExecCommand: execute,
        now: () => 0,
        sleep,
      }),
    ).resolves.toEqual({ ok: true });

    expect(capture.mock.calls.map((call) => call[0])).toEqual([
      ["sandbox", "stop", "alpha"],
      ["sandbox", "start", "alpha"],
    ]);
    const expectedRuntimeOptions = expect.objectContaining({
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "recorded-gateway",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        OPENSHELL_WORKSPACE: "default",
      }),
      replaceEnv: true,
    });
    expect(capture.mock.calls[0][1]).toEqual(expectedRuntimeOptions);
    expect(capture.mock.calls[1][1]).toEqual(expectedRuntimeOptions);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "alpha",
      expect.stringContaining("nemoclaw-openclaw-post-upgrade-doctor-v1"),
      30_000,
      { localDockerFallbackPolicy: "never", runtimeSelection },
    );
    expect(execute.mock.calls.slice(1).every((call) => call[1].includes("curl"))).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not restart when the one-shot marker cannot be persisted", async () => {
    const capture = vi.fn();

    await expect(
      runOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: capture as never,
        executeSandboxExecCommand: vi.fn(async () => null),
        now: () => 0,
        sleep: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({
      ok: false,
      stage: "mark",
      detail: "could not persist the one-shot post-upgrade doctor request",
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("fails closed when restart never consumes the marker", async () => {
    let currentMs = 0;
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValue({ status: 20, stdout: "", stderr: "" });

    await expect(
      runOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: vi.fn(() => ({ status: 0, output: "" })) as never,
        executeSandboxExecCommand: execute,
        now: () => currentMs,
        sleep: vi.fn(async (seconds: number) => {
          currentMs += seconds * 1_000;
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      stage: "restart",
      detail: "the sandbox did not consume its doctor request and return a healthy gateway",
    });
    expect(execute).toHaveBeenCalledTimes(121);
  });

  it("retries one stop/start cycle after a transient unready replacement", async () => {
    let currentMs = 0;
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockImplementation(async () => ({
        status: currentMs >= 180_000 ? 0 : 20,
        stdout: "",
        stderr: "",
      }));
    const capture = vi.fn((_args: readonly string[], _options: Record<string, unknown>) => ({
      status: 0,
      output: "",
    }));

    await expect(
      runOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: capture as never,
        executeSandboxExecCommand: execute,
        now: () => currentMs,
        sleep: vi.fn(async (seconds: number) => {
          currentMs += seconds * 1_000;
        }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(capture.mock.calls.map((call) => call[0])).toEqual([
      ["sandbox", "stop", "alpha"],
      ["sandbox", "start", "alpha"],
      ["sandbox", "stop", "alpha"],
      ["sandbox", "start", "alpha"],
    ]);
  });

  it("caps the final completion probe to the remaining reconciliation budget", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(179_000);

    await expect(
      runOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: vi.fn(() => ({ status: 0, output: "" })) as never,
        executeSandboxExecCommand: execute,
        now,
        sleep: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({ ok: true });

    expect(execute.mock.calls[1]?.[2]).toBe(1_000);
  });
});
