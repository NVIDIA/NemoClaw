// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "../../cli/helpers";

function buildStubOpenshell(home: string, logFile: string, nativeDeleteExit = 0): string {
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
      'case "$*" in',
      '  "sandbox list"*) printf "alpha Ready\\n"; exit 0 ;;',
      '  "sandbox get alpha"*) printf "Name: alpha\\nPhase: Ready\\nPolicy:\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw"*) printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  *"sandbox exec --name alpha -- bash -lc"*)',
      `    printf '%s\\n' '{"ok":true,"key":"agent:main:main","entry":null}'`,
      "    exit 0 ;;",
      `  *"hermes sessions delete"*) exit ${nativeDeleteExit} ;;`,
      "  *) exit 0 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return localBin;
}

function gatewayRpcCalls(logFile: string): string[] {
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("sandbox exec --name alpha -- bash -lc"));
}

describe("sandbox sessions admin RPCs on a non-OpenClaw agent (#7587)", () => {
  it("refuses `sessions reset` on a hermes sandbox instead of dispatching the OpenClaw gateway RPC", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-reset-hermes-"));
    try {
      writeSandboxRegistry(home, "alpha", { agent: "hermes" });
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv("alpha sessions reset agent:main:main 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(result.code).toBe(1);
      expect(result.out).toContain("Refusing to invoke 'sessions.reset' for sandbox 'alpha'");
      expect(result.out).toContain("it uses the 'hermes' agent");
      expect(result.out).toContain("alpha sessions list");
      expect(result.out).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(gatewayRpcCalls(openshellLog)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("routes `sessions delete` on a hermes sandbox to the native command, not the OpenClaw gateway RPC (#7642)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-delete-hermes-"));
    try {
      writeSandboxRegistry(home, "alpha", { agent: "hermes" });
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv("alpha sessions delete 20260727_130357_cb2b61 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(result.code).toBe(0);
      expect(result.out).not.toContain("Refusing to invoke");
      expect(result.out).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(gatewayRpcCalls(openshellLog)).toEqual([]);
      const nativeDeleteCalls = fs
        .readFileSync(openshellLog, "utf8")
        .split("\n")
        .filter((line) => line.includes("hermes sessions delete 20260727_130357_cb2b61 --yes"));
      expect(nativeDeleteCalls.length).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects `--agent hermes` without invoking native delete or the gateway RPC (#7642)", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sessions-delete-hermes-agent-"),
    );
    try {
      writeSandboxRegistry(home, "alpha", { agent: "hermes" });
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv(
        "alpha sessions delete 20260727_130357_cb2b61 --agent hermes 2>&1",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
      );

      expect(result.code).toBe(1);
      expect(result.out).toContain("--agent hermes is OpenClaw-only");
      expect(result.out).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(fs.existsSync(openshellLog)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("propagates a nonzero native hermes delete exit code and makes no gateway RPC (#7642)", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sessions-delete-hermes-fail-"),
    );
    try {
      writeSandboxRegistry(home, "alpha", { agent: "hermes" });
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog, 3);

      const result = runWithEnv("alpha sessions delete 20260727_130357_cb2b61 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(result.code).toBe(3);
      expect(result.out).not.toContain("Refusing to invoke");
      expect(result.out).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(gatewayRpcCalls(openshellLog)).toEqual([]);
      const nativeDeleteCalls = fs
        .readFileSync(openshellLog, "utf8")
        .split("\n")
        .filter((line) => line.includes("hermes sessions delete 20260727_130357_cb2b61 --yes"));
      expect(nativeDeleteCalls.length).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still dispatches the gateway RPC when the registry records no agent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-reset-default-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv("alpha sessions reset agent:main:main --json 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(result.code).toBe(0);
      expect(result.out).not.toContain("Refusing to invoke");
      expect(gatewayRpcCalls(openshellLog).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
