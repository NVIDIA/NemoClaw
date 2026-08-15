// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV,
  COMPATIBLE_ANTHROPIC_PROVIDER,
  compatibleAnthropicSwitchBinding,
  compatibleAnthropicSwitchEnv,
  HOST_VERIFICATION_ALIAS_SCRIPT,
  requireCompatibleAnthropicProviderAbsent,
  withHostVerificationLoopbackAlias,
} from "../fixtures/compatible-anthropic-switch.ts";

describe("compatible Anthropic inference switch setup", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockOwnerStartTime(): void {
    const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "12345"];
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `${process.pid} (node fixture) ${fields.join(" ")}`,
    );
  }

  it("passes the direct binding credential only to the inference-set command", () => {
    const binding = compatibleAnthropicSwitchBinding("http://host.openshell.internal:18766", {
      COMPATIBLE_ANTHROPIC_API_KEY: "fixture-key",
    });

    expect(binding).toEqual({
      endpointUrl: "http://host.openshell.internal:18766",
      credentialValue: "fixture-key",
    });
    expect(compatibleAnthropicSwitchEnv(binding)).toEqual({
      [COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV]: "fixture-key",
    });
    expect(compatibleAnthropicSwitchEnv(null)).toEqual({});
  });

  it("rejects a blank compatible Anthropic endpoint URL", () => {
    expect(() =>
      compatibleAnthropicSwitchBinding("   ", {
        COMPATIBLE_ANTHROPIC_API_KEY: "fixture-key",
      }),
    ).toThrow("NEMOCLAW_SWITCH_ENDPOINT_URL is required");
  });

  it("rejects a blank compatible Anthropic credential", () => {
    expect(() =>
      compatibleAnthropicSwitchBinding("http://host.openshell.internal:18766", {
        COMPATIBLE_ANTHROPIC_API_KEY: "   ",
      }),
    ).toThrow("COMPATIBLE_ANTHROPIC_API_KEY is required");
  });

  it("removes its host alias when verification fails", async () => {
    mockOwnerStartTime();
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const trackDisposable = vi.fn();

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        { trackDisposable },
        async () => {
          throw new Error("verification failed");
        },
      ),
    ).rejects.toThrow("verification failed");

    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map(([program, args]) => [program, args?.[0], args?.[4]])).toEqual([
      ["sudo", "bash", "add"],
      ["sudo", "bash", "remove"],
    ]);
    expect(trackDisposable.mock.invocationCallOrder[0]).toBeLessThan(
      command.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("retries a failed owned-alias removal through tracked cleanup", async () => {
    mockOwnerStartTime();
    const command = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "permission denied", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });
    const trackDisposable = vi.fn();

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        { trackDisposable },
        async () => undefined,
      ),
    ).rejects.toThrow("could not remove the host verifier alias: permission denied");

    const trackedCleanup = trackDisposable.mock.calls[0]?.[1] as () => Promise<void>;
    await expect(trackedCleanup()).resolves.toBeUndefined();
    expect(command.mock.calls.map(([, args]) => args?.[4])).toEqual(["add", "remove", "remove"]);
  });

  it("removes a possible alias after the mapping runner disconnects", async () => {
    mockOwnerStartTime();
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("mapping runner disconnected"))
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });

    await expect(
      withHostVerificationLoopbackAlias(
        { command } as unknown as HostCliClient,
        { trackDisposable: vi.fn() },
        async () => undefined,
      ),
    ).rejects.toThrow("mapping runner disconnected");

    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map(([, args]) => args?.[4])).toEqual(["add", "remove"]);
  });

  it("requires the direct provider to be absent before inference set owns its creation", async () => {
    const command = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
      stdout: "",
    });
    const host = { command } as unknown as HostCliClient;
    const commandEnv = { OPENSHELL_GATEWAY: "nemoclaw" };

    await expect(
      requireCompatibleAnthropicProviderAbsent(host, {
        artifactName: "compatible-anthropic-provider-absent",
        env: commandEnv,
      }),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledWith(
      "openshell",
      ["provider", "get", "-g", "nemoclaw", COMPATIBLE_ANTHROPIC_PROVIDER],
      expect.objectContaining({
        artifactName: "compatible-anthropic-provider-absent",
        env: commandEnv,
      }),
    );
  });

  it("rejects a pre-existing or uninspectable direct provider", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `Name: ${COMPATIBLE_ANTHROPIC_PROVIDER}`,
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "gateway unavailable",
        stdout: "",
      });
    const host = { command } as unknown as HostCliClient;
    const options = { artifactName: "provider-absent", env: {} };

    await expect(requireCompatibleAnthropicProviderAbsent(host, options)).rejects.toThrow(
      "must be absent",
    );
    await expect(requireCompatibleAnthropicProviderAbsent(host, options)).rejects.toThrow(
      "Could not prove",
    );
  });
});

const linuxIt = process.platform === "linux" ? it : it.skip;

describe("host verifier alias file ownership", () => {
  function processStartTime(pid: number): string {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(") ");
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    expect(startTime, `process start time for ${pid}`).toBeDefined();
    return startTime as string;
  }

  function runAliasScript(
    operation: "add" | "remove",
    hostsPath: string,
    lockPath: string,
    owner: { pid: number; startTime: string; token: string },
  ): void {
    const result = spawnSync(
      "bash",
      [
        "-ceu",
        HOST_VERIFICATION_ALIAS_SCRIPT,
        "host-verifier-alias-test",
        operation,
        hostsPath,
        lockPath,
        String(owner.pid),
        owner.startTime,
        owner.token,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  }

  function testFiles(): { directory: string; hostsPath: string; lockPath: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-verifier-test-"));
    const hostsPath = path.join(directory, "hosts");
    const lockPath = path.join(directory, "hosts.lock");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n", { mode: 0o644 });
    return { directory, hostsPath, lockPath };
  }

  linuxIt("preserves a concurrent resolver update while removing its owned alias", () => {
    const files = testFiles();
    const owner = {
      pid: process.pid,
      startTime: processStartTime(process.pid),
      token: "a".repeat(32),
    };
    try {
      runAliasScript("add", files.hostsPath, files.lockPath, owner);
      fs.appendFileSync(files.hostsPath, "192.0.2.10 concurrent.example.test\n");
      runAliasScript("remove", files.hostsPath, files.lockPath, owner);

      expect(fs.readFileSync(files.hostsPath, "utf8")).toBe(
        "127.0.0.1 localhost\n192.0.2.10 concurrent.example.test\n",
      );
    } finally {
      fs.rmSync(files.directory, { force: true, recursive: true });
    }
  });

  linuxIt("serializes active owners through a persistent kernel-lock file", () => {
    const files = testFiles();
    const startTime = processStartTime(process.pid);
    const first = { pid: process.pid, startTime, token: "b".repeat(32) };
    const second = { pid: process.pid, startTime, token: "c".repeat(32) };
    try {
      fs.writeFileSync(files.lockPath, "stale lock inode\n", { mode: 0o600 });
      runAliasScript("add", files.hostsPath, files.lockPath, first);
      runAliasScript("add", files.hostsPath, files.lockPath, second);
      runAliasScript("remove", files.hostsPath, files.lockPath, first);
      expect(fs.readFileSync(files.hostsPath, "utf8")).toContain(second.token);
      runAliasScript("remove", files.hostsPath, files.lockPath, second);
      expect(fs.readFileSync(files.hostsPath, "utf8")).not.toContain(
        "host.openshell.internal",
      );
    } finally {
      fs.rmSync(files.directory, { force: true, recursive: true });
    }
  });

  linuxIt("removes an alias whose owner process was killed", async () => {
    const files = testFiles();
    const killed = spawn("sleep", ["30"], { stdio: "ignore" });
    expect(killed.pid, "killed-owner fixture PID").toBeDefined();
    const killedPid = killed.pid as number;
    const killedExit = new Promise<void>((resolve) => killed.once("exit", () => resolve()));
    const killedOwner = {
      pid: killedPid,
      startTime: processStartTime(killedPid),
      token: "d".repeat(32),
    };
    const currentOwner = {
      pid: process.pid,
      startTime: processStartTime(process.pid),
      token: "e".repeat(32),
    };
    try {
      runAliasScript("add", files.hostsPath, files.lockPath, killedOwner);
      killed.kill("SIGKILL");
      await killedExit;
      runAliasScript("add", files.hostsPath, files.lockPath, currentOwner);
      const recovered = fs.readFileSync(files.hostsPath, "utf8");
      expect(recovered).not.toContain(killedOwner.token);
      expect(recovered).toContain(currentOwner.token);
      runAliasScript("remove", files.hostsPath, files.lockPath, currentOwner);
      expect(fs.readFileSync(files.hostsPath, "utf8")).not.toContain(
        "host.openshell.internal",
      );
    } finally {
      killed.kill("SIGKILL");
      fs.rmSync(files.directory, { force: true, recursive: true });
    }
  });
});
