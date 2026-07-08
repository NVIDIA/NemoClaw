// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
      "  *) exit 0 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return localBin;
}

describe("sandbox download/upload CLI wrappers", () => {
  it("forwards `<name> download <sandbox-path> [host-dest]` to openshell with the host-dest resolved against the caller cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-download-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv("alpha download /sandbox/.openclaw/workspace/SOUL.md ./out 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      const expectedHostDest = path.resolve(process.cwd(), "out");
      expect(calls).toContain(
        `sandbox download alpha /sandbox/.openclaw/workspace/SOUL.md ${expectedHostDest}`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("defaults the host destination to the caller cwd when omitted", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-download-default-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv("alpha download /sandbox/.openclaw/x 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      expect(calls).toContain(`sandbox download alpha /sandbox/.openclaw/x ${process.cwd()}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("forwards `<name> upload <host-path> [sandbox-dest]` to openshell with the host-path resolved against the caller cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-upload-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv(
        "alpha upload ./SOUL.md /sandbox/.openclaw/workspace/SOUL.md 2>&1",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
      );
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      const expectedHostPath = path.resolve(process.cwd(), "SOUL.md");
      expect(calls).toContain(
        `sandbox upload alpha ${expectedHostPath} /sandbox/.openclaw/workspace/SOUL.md`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("defaults the sandbox destination to /sandbox/ when omitted and still resolves the host path against the caller cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-upload-default-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog);

      const result = runWithEnv("alpha upload ./x 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      const expectedHostPath = path.resolve(process.cwd(), "x");
      expect(calls).toContain(`sandbox upload alpha ${expectedHostPath} /sandbox/`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
