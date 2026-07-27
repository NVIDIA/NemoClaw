// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "./cli/helpers";

function buildStubOpenshell(home: string, logFile: string): string {
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
  for (const verb of ["reset", "delete"] as const) {
    it(`refuses \`sessions ${verb}\` on a hermes sandbox instead of dispatching the OpenClaw gateway RPC`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-cli-sessions-${verb}-hermes-`));
      try {
        writeSandboxRegistry(home, "alpha", { agent: "hermes" });
        const openshellLog = path.join(home, "openshell-calls.log");
        const localBin = buildStubOpenshell(home, openshellLog);

        const result = runWithEnv(`alpha sessions ${verb} agent:main:main 2>&1`, {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain(`Refusing to invoke 'sessions.${verb}' for sandbox 'alpha'`);
        expect(result.out).toContain("it uses the 'hermes' agent");
        expect(result.out).toContain("alpha sessions list");
        expect(result.out).not.toContain("OPENCLAW_GATEWAY_TOKEN");
        expect(gatewayRpcCalls(openshellLog)).toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

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
