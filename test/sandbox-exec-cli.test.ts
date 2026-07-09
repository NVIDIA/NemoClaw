// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "./cli/helpers";

function buildExecExitStubOpenshell(home: string, remoteExitCode: number): string {
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      'case "$*" in',
      '  *"sandbox exec"*)',
      `    exit ${remoteExitCode} ;;`,
      "  *) exit 0 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return localBin;
}

function execCliEnv(home: string, localBin: string): Record<string, string> {
  return {
    HOME: home,
    PATH: `${localBin}:${process.env.PATH || ""}`,
  };
}

describe("sandbox exec CLI exit propagation (#6458)", () => {
  it("forwards a non-zero remote exit code through the public route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-exec-exit-public-"));
    try {
      writeSandboxRegistry(home, { agent: "hermes" });
      const localBin = buildExecExitStubOpenshell(home, 42);

      const result = runWithEnv("alpha exec -- sh -c 'exit 42' 2>&1", execCliEnv(home, localBin));
      expect(result.code).toBe(42);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("forwards exit 1 through the public route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-exec-exit-one-"));
    try {
      writeSandboxRegistry(home, { agent: "hermes" });
      const localBin = buildExecExitStubOpenshell(home, 1);

      const result = runWithEnv("alpha exec -- sh -c 'exit 1' 2>&1", execCliEnv(home, localBin));
      expect(result.code).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns 0 when the remote command succeeds", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-exec-exit-zero-"));
    try {
      writeSandboxRegistry(home, { agent: "hermes" });
      const localBin = buildExecExitStubOpenshell(home, 0);

      const result = runWithEnv("alpha exec -- echo hello 2>&1", execCliEnv(home, localBin));
      expect(result.code).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("forwards a non-zero remote exit code through the native sandbox exec route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-exec-exit-native-"));
    try {
      writeSandboxRegistry(home, { agent: "hermes" });
      const localBin = buildExecExitStubOpenshell(home, 7);

      const result = runWithEnv(
        "sandbox exec alpha -- sh -c 'exit 7' 2>&1",
        execCliEnv(home, localBin),
      );
      expect(result.code).toBe(7);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
