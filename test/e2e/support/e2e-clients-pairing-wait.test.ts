// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { type CommandRunner, SandboxClient } from "../fixtures/clients/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

type FakeRunnerResponse = Partial<
  Pick<ShellProbeResult, "exitCode" | "signal" | "stderr" | "stdout" | "timedOut">
>;

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  readonly responses: FakeRunnerResponse[] = [];

  enqueue(response: FakeRunnerResponse): void {
    this.responses.push(response);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    const response = this.responses.shift();
    return {
      command: [command.command, ...command.args],
      exitCode: response?.exitCode ?? 0,
      signal: response?.signal ?? null,
      timedOut: response?.timedOut ?? false,
      stdout: response?.stdout ?? "",
      stderr: response?.stderr ?? "",
      artifacts: {
        stdout: "/tmp/stdout.txt",
        stderr: "/tmp/stderr.txt",
        result: "/tmp/result.json",
      },
    };
  }
}

const LOCAL_CLI_DEVICE = {
  deviceId: "device-local",
  clientId: "cli",
  clientMode: "cli",
  tokens: { operator: { token: "operator-token-local" } },
};

function writePairingFile(stateDir: string, relativePath: string, value: unknown): void {
  const file = path.join(stateDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** The `node -e <program>` argv the sandbox client sends, captured through the fake runner. */
async function recordedPairingWait(): Promise<string[]> {
  const runner = new FakeRunner();
  await new SandboxClient(runner, { openshellPath: "openshell" }).waitForInitialOpenClawPairing(
    "assistant",
  );
  return runner.calls[0].args.slice(5, 8);
}

describe("E2E fixture client OpenClaw pairing wait", () => {
  it("builds the bounded initial OpenClaw pairing wait", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.waitForInitialOpenClawPairing("assistant");

    expect(runner.calls[0]).toEqual({
      command: "openshell",
      args: [
        "sandbox",
        "exec",
        "-n",
        "assistant",
        "--",
        "node",
        "-e",
        expect.stringContaining("state/openclaw.sqlite"),
        "60000",
        "/sandbox/.openclaw",
      ],
      options: {
        artifactName: "wait-for-initial-openclaw-pairing",
        timeoutMs: 70_000,
      },
    });
  });

  it("accepts the canonical OpenClaw SQLite pairing state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-wait-sqlite-"));
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE device_identities (
          identity_key TEXT PRIMARY KEY,
          device_id TEXT NOT NULL
        );
        CREATE TABLE device_auth_tokens (
          device_id TEXT NOT NULL,
          role TEXT NOT NULL,
          token TEXT NOT NULL,
          PRIMARY KEY (device_id, role)
        );
        CREATE TABLE device_pairing_paired (
          device_id TEXT PRIMARY KEY,
          client_id TEXT,
          client_mode TEXT,
          tokens_json TEXT
        );
      `);
      database
        .prepare("INSERT INTO device_identities (identity_key, device_id) VALUES ('primary', ?)")
        .run(LOCAL_CLI_DEVICE.deviceId);
      database
        .prepare(
          "INSERT INTO device_auth_tokens (device_id, role, token) VALUES (?, 'operator', ?)",
        )
        .run(LOCAL_CLI_DEVICE.deviceId, LOCAL_CLI_DEVICE.tokens.operator.token);
      database
        .prepare(
          "INSERT INTO device_pairing_paired (device_id, client_id, client_mode, tokens_json) VALUES (?, 'cli', 'cli', ?)",
        )
        .run(LOCAL_CLI_DEVICE.deviceId, JSON.stringify(LOCAL_CLI_DEVICE.tokens));
    } finally {
      database.close();
    }

    try {
      const [command, ...args] = await recordedPairingWait();
      const result = spawnSync(command, [...args, "1000", stateDir], {
        encoding: "utf8",
        timeout: 2_000,
        killSignal: "SIGKILL",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("exits 0 once the local CLI device is paired with the stored token (#11085)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-wait-"));
    try {
      writePairingFile(stateDir, "identity/device.json", { deviceId: LOCAL_CLI_DEVICE.deviceId });
      const [command, ...args] = await recordedPairingWait();
      const child = spawn(command, [...args, "3000", stateDir], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      setTimeout(() => {
        writePairingFile(stateDir, "devices/paired.json", {
          [LOCAL_CLI_DEVICE.deviceId]: LOCAL_CLI_DEVICE,
        });
        writePairingFile(stateDir, "identity/device-auth.json", {
          tokens: LOCAL_CLI_DEVICE.tokens,
        });
      }, 400);

      const [status] = await once(child, "exit");
      expect(status).toBe(0);
      expect(output).toBe("");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("exits 1 at the deadline without a matching CLI record (#11085)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-wait-"));
    try {
      const [command, ...args] = await recordedPairingWait();
      const attempt = (paired: Record<string, unknown>) => {
        writePairingFile(stateDir, "devices/paired.json", paired);
        return spawnSync(command, [...args, "200", stateDir], {
          encoding: "utf8",
          timeout: 2_000,
          killSignal: "SIGKILL",
        });
      };
      writePairingFile(stateDir, "identity/device.json", { deviceId: LOCAL_CLI_DEVICE.deviceId });
      const authMissing = attempt({ [LOCAL_CLI_DEVICE.deviceId]: LOCAL_CLI_DEVICE });
      writePairingFile(stateDir, "identity/device-auth.json", {
        tokens: { operator: { token: "operator-token-stale" } },
      });
      const staleToken = attempt({ [LOCAL_CLI_DEVICE.deviceId]: LOCAL_CLI_DEVICE });
      writePairingFile(stateDir, "identity/device-auth.json", { tokens: LOCAL_CLI_DEVICE.tokens });
      const foreignDevice = attempt({
        "device-other": { ...LOCAL_CLI_DEVICE, deviceId: "device-other" },
      });
      const nonCli = attempt({
        [LOCAL_CLI_DEVICE.deviceId]: { ...LOCAL_CLI_DEVICE, clientMode: "ui" },
      });

      const results = [authMissing, staleToken, foreignDevice, nonCli];
      expect(results.map((result) => result.status)).toEqual([1, 1, 1, 1]);
      expect(results.map((result) => result.stdout)).toEqual(["", "", "", ""]);
      expect(results.some((result) => result.stderr.includes("operator-token"))).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a nonzero initial pairing wait (#11085)", async () => {
    const runner = new FakeRunner();
    runner.enqueue({ exitCode: 1 });
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await expect(sandbox.waitForInitialOpenClawPairing("assistant")).rejects.toThrow(
      "wait for initial OpenClaw CLI pairing in assistant failed: exit=1",
    );
  });
});
