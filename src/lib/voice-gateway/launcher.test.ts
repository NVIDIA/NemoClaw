// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn() };
});

import { spawn } from "node:child_process";

import {
  buildVoiceGatewayLaunchContract,
  launchVoiceGateway,
  VoiceGatewayTerminationUnconfirmedError,
} from "./launcher";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-launcher-"));
  directories.push(directory);
  return directory;
}

function options() {
  const directory = temporaryDirectory();
  return {
    deploymentCredentialPath: path.join(directory, "deployment"),
    openClawCredentialPath: path.join(directory, "openclaw"),
    gatewayUrl: "ws://127.0.0.1:18789/ws",
    runtimeIdentity: "voiceclaw-local",
    runtimeProfile: "voiceclaw-pinned",
    sandbox: "repository-fixture",
    agent: "main",
    listenPort: 18800,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("voice gateway launcher", () => {
  it("keeps credential source paths and values out of the child contract (#9235)", () => {
    const launchOptions = options();
    const contract = buildVoiceGatewayLaunchContract(launchOptions);

    expect(contract.args).not.toContain(launchOptions.deploymentCredentialPath);
    expect(contract.args).not.toContain(launchOptions.openClawCredentialPath);
    expect(contract.env).toEqual({ NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "1" });
  });

  it("rejects a symbolic-link credential source before launch (#9235)", async () => {
    const launchOptions = options();
    const target = path.join(path.dirname(launchOptions.deploymentCredentialPath), "target");
    fs.writeFileSync(target, "deployment-credential-for-launcher-012345", { mode: 0o600 });
    fs.symlinkSync(target, launchOptions.deploymentCredentialPath);
    fs.writeFileSync(
      launchOptions.openClawCredentialPath,
      "openclaw-credential-for-launcher-01234567",
      { mode: 0o600 },
    );

    await expect(launchVoiceGateway(launchOptions)).rejects.toThrow("symbolic link");
    await expect(launchVoiceGateway(launchOptions)).rejects.toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(launchOptions.deploymentCredentialPath),
      }),
    );
  });

  it("terminates and reaps the child when parent descriptor cleanup fails (#9235)", async () => {
    const launchOptions = options();
    fs.writeFileSync(
      launchOptions.deploymentCredentialPath,
      "deployment-credential-for-launcher-012345",
      { mode: 0o600 },
    );
    fs.writeFileSync(
      launchOptions.openClawCredentialPath,
      "openclaw-credential-for-launcher-01234567",
      { mode: 0o600 },
    );
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        return true;
      }),
    });
    vi.mocked(spawn).mockReturnValueOnce(child);
    const close = fs.closeSync.bind(fs);
    vi.spyOn(fs, "closeSync")
      .mockImplementationOnce((descriptor) => {
        close(descriptor);
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      })
      .mockImplementation(close);

    await expect(launchVoiceGateway(launchOptions)).rejects.toThrow("close failed");
    const stdio = vi.mocked(spawn).mock.calls[0]?.[2]?.stdio as number[];
    expect(() => fs.fstatSync(stdio[3]!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    expect(() => fs.fstatSync(stdio[4]!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("returns the child handle when bounded termination is unconfirmed (#9235)", async () => {
    vi.useFakeTimers();
    const launchOptions = options();
    fs.writeFileSync(
      launchOptions.deploymentCredentialPath,
      "deployment-credential-for-launcher-012345",
      { mode: 0o600 },
    );
    fs.writeFileSync(
      launchOptions.openClawCredentialPath,
      "openclaw-credential-for-launcher-01234567",
      { mode: 0o600 },
    );
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValueOnce(child);
    const close = fs.closeSync.bind(fs);
    vi.spyOn(fs, "closeSync")
      .mockImplementationOnce((descriptor) => {
        close(descriptor);
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      })
      .mockImplementation(close);

    const launch = launchVoiceGateway(launchOptions).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    const error = await launch;
    expect(error).toBeInstanceOf(VoiceGatewayTerminationUnconfirmedError);
    expect(error).toMatchObject({
      child,
      cause: expect.objectContaining({ message: "close failed" }),
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("retains the child handle when process control emits an error (#9235)", async () => {
    const launchOptions = options();
    fs.writeFileSync(
      launchOptions.deploymentCredentialPath,
      "deployment-credential-for-launcher-012345",
      { mode: 0o600 },
    );
    fs.writeFileSync(
      launchOptions.openClawCredentialPath,
      "openclaw-credential-for-launcher-01234567",
      { mode: 0o600 },
    );
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("error", new Error("kill failed")));
        return true;
      }),
    });
    vi.mocked(spawn).mockReturnValueOnce(child);
    const close = fs.closeSync.bind(fs);
    vi.spyOn(fs, "closeSync")
      .mockImplementationOnce((descriptor) => {
        close(descriptor);
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      })
      .mockImplementation(close);

    const error = await launchVoiceGateway(launchOptions).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(VoiceGatewayTerminationUnconfirmedError);
    expect(error).toMatchObject({
      child,
      cause: expect.objectContaining({ message: "close failed" }),
    });
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });
});
