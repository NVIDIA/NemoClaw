// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";

import {
  buildSandboxConfigSyncScript,
  createNemoClawConfigSync,
  runSandboxConfigSync,
} from "./config-sync";

const itUnix = process.platform === "win32" ? it.skip : it;

function writeFakeCommand(binDir: string, name: string, stdout: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, { mode: 0o755 });
}

function runConfigSyncScript(
  script: string,
  homeDir: string,
  fakeUid: string,
  fakeOwnerUid = fakeUid,
): void {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-bin-"));
  try {
    writeFakeCommand(fakeBin, "id", fakeUid);
    writeFakeCommand(fakeBin, "stat", fakeOwnerUid);
    const testScript = script
      .replace(
        'nemoclaw_dir="/sandbox/.nemoclaw"',
        `nemoclaw_dir=${JSON.stringify(path.join(homeDir, ".nemoclaw"))}`,
      )
      .replace(
        "config_dir=/sandbox/.openclaw",
        `config_dir=${JSON.stringify(path.join(homeDir, ".openclaw"))}`,
      );
    const result = spawnSync("bash", ["-c", testScript], {
      cwd: homeDir,
      env: { ...process.env, HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
}

function modeBits(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("sandbox config sync helpers", () => {
  describe("OpenShell readiness recovery", () => {
    const notReady = {
      outcome: { kind: "completed" as const, exitCode: 1 },
      stdout: "",
      stderr:
        "Error: \u001b[31m×\u001b[0m sandbox 'spark-box' is not ready (phase: Error); wait for it to\n  │ reach Ready state\n",
    };
    const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>();
    const inspectSandboxIdentity = vi.fn(() => "original-identity");
    const syncConfig = createNemoClawConfigSync(
      {
        inspectSandboxIdentity,
        getProviderSelectionConfig: () => ({
          endpointType: "custom",
          endpointUrl: "https://inference.local/v1",
          ncpPartner: null,
          model: "model",
          profile: "inference-local",
          credentialEnv: "OPENAI_API_KEY",
          provider: "provider",
          providerLabel: "Provider",
        }),
        sandboxCommandExecutor: { runBuffered },
      },
      () => "nemoclaw",
    );

    beforeEach(() => {
      vi.useFakeTimers();
      runBuffered.mockReset().mockResolvedValue(notReady);
      inspectSandboxIdentity.mockReset().mockReturnValue("original-identity");
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each(["", "."])(
      "syncs after a transient Error rejection with %j final punctuation",
      async (punctuation) => {
        runBuffered
          .mockResolvedValueOnce({
            ...notReady,
            stderr: notReady.stderr.trimEnd() + punctuation + "\n",
          })
          .mockResolvedValueOnce({
            outcome: { kind: "completed", exitCode: 0 },
            stdout: "",
            stderr: "",
          });
        const revalidate = vi.fn();
        const pending = expect(
          syncConfig("spark-box", "provider", "model", revalidate),
        ).resolves.toBeUndefined();

        await Promise.all([pending, vi.advanceTimersByTimeAsync(2_000)]);

        expect(runBuffered).toHaveBeenCalledTimes(2);
        expect(revalidate).toHaveBeenCalledTimes(2);
        expect(inspectSandboxIdentity.mock.calls).toEqual([
          [{ sandboxName: "spark-box", gatewayName: "nemoclaw", timeoutMs: 60_000 }],
          [{ sandboxName: "spark-box", gatewayName: "nemoclaw", timeoutMs: 58_000 }],
        ]);
        expect(runBuffered.mock.calls[1][0].input).toBe(runBuffered.mock.calls[0][0].input);
        expect(runBuffered.mock.calls[1][0].timeoutMilliseconds).toBe(58_000);
        expect(process.stderr.write).toHaveBeenCalledWith(
          notReady.stderr.trimEnd() + punctuation + "\n",
        );
      },
    );

    it("does not wait when the first config-sync execution succeeds", async () => {
      runBuffered.mockResolvedValue({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "",
        stderr: "",
      });
      await syncConfig("spark-box", "provider", "model");
      expect(runBuffered).toHaveBeenCalledTimes(1);
      expect(inspectSandboxIdentity).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects a replaced sandbox on retry even without the optional callback", async () => {
      inspectSandboxIdentity
        .mockReturnValueOnce("original-identity")
        .mockReturnValue("replacement-identity");
      const pending = expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow(
        "identity changed before config-sync retry",
      );
      await Promise.all([pending, vi.advanceTimersByTimeAsync(2_000)]);
      expect(runBuffered).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not execute when the initial identity cannot be read", async () => {
      inspectSandboxIdentity.mockImplementation(() => {
        throw new Error("identity unavailable");
      });
      await expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow(
        "identity unavailable",
      );
      expect(runBuffered).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not retry when the identity cannot be read again", async () => {
      inspectSandboxIdentity.mockReturnValueOnce("original-identity");
      inspectSandboxIdentity.mockImplementation(() => {
        throw new Error("identity unavailable");
      });
      const pending = expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow(
        "identity unavailable",
      );
      await Promise.all([pending, vi.advanceTimersByTimeAsync(2_000)]);
      expect(runBuffered).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not execute after an identity read consumes the remaining deadline", async () => {
      inspectSandboxIdentity.mockReturnValueOnce("original-identity").mockImplementation(() => {
        vi.setSystemTime(Date.now() + 58_000);
        return "original-identity";
      });
      const pending = expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow(
        "did not return to Ready within 60s",
      );
      await Promise.all([pending, vi.advanceTimersByTimeAsync(2_000)]);
      expect(runBuffered).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops after 60 seconds if OpenShell keeps rejecting execution", async () => {
      const pending = expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow(
        "did not return to Ready within 60s",
      );
      await Promise.all([pending, vi.advanceTimersByTimeAsync(60_000)]);
      const attempts = runBuffered.mock.calls.length;
      expect(attempts).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runBuffered).toHaveBeenCalledTimes(attempts);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not execute again when sandbox identity changes while waiting", async () => {
      const revalidate = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error("sandbox identity changed");
        });
      const pending = expect(
        syncConfig("spark-box", "provider", "model", revalidate),
      ).rejects.toThrow("sandbox identity changed");
      await Promise.all([pending, vi.advanceTimersByTimeAsync(2_000)]);
      expect(runBuffered).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["another sandbox", { stderr: notReady.stderr.replace("spark-box", "other-box") }],
      ["another phase", { stderr: notReady.stderr.replace("phase: Error", "phase: Stopped") }],
      ["a script error", { stderr: "permission denied\n" }],
      ["possible script execution", { stdout: "script started\n" }],
      [
        "a terminated command",
        { outcome: { kind: "completed" as const, exitCode: 1, signal: "SIGTERM" as const } },
      ],
      [
        "a transport timeout",
        {
          outcome: {
            kind: "failed" as const,
            error: { kind: "timeout" as const, message: "config sync timed out" },
          },
        },
      ],
    ])("does not retry %s", async (_label, override) => {
      runBuffered.mockResolvedValue({ ...notReady, ...override });
      await expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow();
      expect(runBuffered).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("revalidates sandbox identity immediately before sandbox execution", async () => {
    const runBuffered = vi.fn();
    const revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("sandbox identity changed");
    });
    const syncConfig = createNemoClawConfigSync(
      {
        inspectSandboxIdentity: () => "original-identity",
        getProviderSelectionConfig: () => ({
          endpointType: "custom",
          endpointUrl: "https://inference.local/v1",
          ncpPartner: null,
          model: "model",
          profile: "inference-local",
          credentialEnv: "OPENAI_API_KEY",
          provider: "provider",
          providerLabel: "Provider",
        }),
        sandboxCommandExecutor: { runBuffered },
      },
      () => "nemoclaw",
    );

    await expect(
      syncConfig("spark-box", "provider", "model", revalidateSandboxIdentity),
    ).rejects.toThrow("sandbox identity changed");

    expect(revalidateSandboxIdentity).toHaveBeenCalledExactlyOnceWith(
      "synchronize OpenClaw config in sandbox 'spark-box'",
    );
    expect(runBuffered).not.toHaveBeenCalled();
  });

  it("uses noninteractive buffered sandbox exec for stdin scripts", async () => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: "",
      stderr: "",
    }));
    const syncConfig = createNemoClawConfigSync(
      {
        inspectSandboxIdentity: () => "original-identity",
        getProviderSelectionConfig: () => ({
          endpointType: "custom",
          endpointUrl: "https://inference.local/v1",
          ncpPartner: null,
          model: "model",
          profile: "inference-local",
          credentialEnv: "OPENAI_API_KEY",
          provider: "provider",
          providerLabel: "Provider",
        }),
        sandboxCommandExecutor: { runBuffered },
      },
      () => "nemoclaw",
    );

    await syncConfig("spark-box", "provider", "model");

    expect(runBuffered).toHaveBeenCalledWith({
      sandboxName: "spark-box",
      target: { kind: "named", gatewayName: "nemoclaw" },
      command: ["/bin/bash", "-s"],
      tty: false,
      input: expect.stringContaining('"provider": "provider"'),
      timeoutMilliseconds: expect.any(Number),
      timeoutKillSignal: "SIGKILL",
    });
  });

  it("propagates typed sandbox execution failures", async () => {
    const syncConfig = createNemoClawConfigSync(
      {
        inspectSandboxIdentity: () => "original-identity",
        getProviderSelectionConfig: () => ({
          endpointType: "custom",
          endpointUrl: "https://inference.local/v1",
          ncpPartner: null,
          model: "model",
          profile: "inference-local",
          credentialEnv: "OPENAI_API_KEY",
          provider: "provider",
          providerLabel: "Provider",
        }),
        sandboxCommandExecutor: {
          runBuffered: async () => ({
            outcome: {
              kind: "failed",
              error: { kind: "timeout", message: "config sync timed out" },
            },
            stdout: "",
            stderr: "",
          }),
        },
      },
      () => "nemoclaw",
    );

    await expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow(
      "config sync timed out",
    );
  });

  itUnix("writes provider selection and tightens managed config permissions", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    try {
      const nemoclawDir = path.join(homeDir, ".nemoclaw");
      const openclawDir = path.join(homeDir, ".openclaw");
      const nestedOpenclawDir = path.join(openclawDir, "nested");
      const openclawConfig = path.join(openclawDir, "openclaw.json");
      const openclawHash = path.join(openclawDir, ".config-hash");
      fs.mkdirSync(nemoclawDir, { mode: 0o755 });
      fs.chmodSync(nemoclawDir, 0o755);
      fs.mkdirSync(nestedOpenclawDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(openclawConfig, "existing OpenClaw config\n", { mode: 0o644 });
      fs.writeFileSync(openclawHash, "existing hash\n", { mode: 0o644 });
      const selection = {
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "nemotron-3-nano:30b",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        provider: "compatible-endpoint",
        providerLabel: "Other OpenAI-compatible endpoint",
      } as const;
      const script = buildSandboxConfigSyncScript(selection);

      runConfigSyncScript(script, homeDir, "1234");

      expect(JSON.parse(fs.readFileSync(path.join(nemoclawDir, "config.json"), "utf8"))).toEqual(
        selection,
      );
      expect(modeBits(nemoclawDir)).toBe(0o700);
      expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
      expect(fs.readFileSync(openclawConfig, "utf8")).toBe("existing OpenClaw config\n");
      expect(fs.readFileSync(openclawHash, "utf8")).toBe("existing hash\n");
      expect(fs.statSync(openclawDir).mode & 0o7777).toBe(0o2770);
      expect(fs.statSync(nestedOpenclawDir).mode & 0o7777).toBe(0o2770);
      expect(modeBits(openclawConfig)).toBe(0o660);
      expect(modeBits(openclawHash)).toBe(0o660);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  itUnix("keeps credential values out of sandbox selection config", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    try {
      const selection = {
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        profile: "inference-local",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        provider: "compatible-anthropic-endpoint",
        providerLabel: "Other Anthropic-compatible endpoint",
      } as const;
      const script = buildSandboxConfigSyncScript(selection);

      runConfigSyncScript(script, homeDir, "1234");

      expect(
        JSON.parse(fs.readFileSync(path.join(homeDir, ".nemoclaw", "config.json"), "utf8")),
      ).toEqual(selection);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  itUnix("does not chmod a NemoClaw config dir owned by another user", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    try {
      const nemoclawDir = path.join(homeDir, ".nemoclaw");
      fs.mkdirSync(nemoclawDir, { mode: 0o755 });
      fs.chmodSync(nemoclawDir, 0o755);
      const script = buildSandboxConfigSyncScript({
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "nemotron-3-nano:30b",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        provider: "compatible-endpoint",
        providerLabel: "Other OpenAI-compatible endpoint",
      });

      runConfigSyncScript(script, homeDir, "1234", "0");
      expect(modeBits(nemoclawDir)).toBe(0o755);
      expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  itUnix("passes the generated script directly to the sandbox executor", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    const runConnectScript = vi.fn<(sandboxName: string, scriptContent: string) => Promise<void>>(
      async () => undefined,
    );
    const selection = {
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "model",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "provider",
      providerLabel: "Provider",
    } as const;
    try {
      await runSandboxConfigSync("spark-box", {
        getSelectionConfig: () => selection,
        runConnectScript,
      });

      expect(runConnectScript).toHaveBeenCalledTimes(1);
      const [sandboxName, script] = runConnectScript.mock.calls[0]!;
      expect(sandboxName).toBe("spark-box");
      runConfigSyncScript(script, homeDir, "1234");
      expect(
        JSON.parse(fs.readFileSync(path.join(homeDir, ".nemoclaw", "config.json"), "utf8")),
      ).toMatchObject({ ...selection, onboardedAt: expect.any(String) });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
