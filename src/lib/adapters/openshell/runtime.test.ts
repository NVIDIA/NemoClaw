// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureResolvedOpenshell, runOpenshell } from "./runtime";

const directories: string[] = [];

function executable(name: string, output: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-capture-test-"));
  directories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `#!/bin/sh\nprintf ${output}`, { mode: 0o755 });
  return filePath;
}

function blockingExecutable(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-runtime-test-"));
  directories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(
    filePath,
    `#!${process.execPath}\nconst lock = new Int32Array(new SharedArrayBuffer(4));\nAtomics.wait(lock, 0, 0, 10_000);\n`,
    { mode: 0o755 },
  );
  return filePath;
}

function largeOutputExecutable(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-runtime-test-"));
  directories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `#!${process.execPath}\nprocess.stdout.write("x".repeat(1024));\n`, {
    mode: 0o755,
  });
  return filePath;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runOpenshell", () => {
  it("forwards SIGKILL to a timed-out OpenShell command (#9050)", () => {
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", blockingExecutable("openshell"));

    const result = runOpenshell([], {
      ignoreError: true,
      timeout: 100,
      killSignal: "SIGKILL",
    });

    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(result.signal).toBe("SIGKILL");
  });

  it("enforces the caller's output bound when stdout is captured (#9875)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = runOpenshell([], {
      openshellBinary: largeOutputExecutable("openshell"),
      ignoreError: true,
      maxBuffer: 64,
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOBUFS");
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("captureResolvedOpenshell", () => {
  it("invokes the exact canonical executable supplied by the caller", () => {
    const decoy = executable("decoy", "decoy");
    const snapshot = executable("snapshot", "snapshot");

    const result = captureResolvedOpenshell([], {
      openshellBinary: snapshot,
      env: { NEMOCLAW_OPENSHELL_BIN: decoy },
      replaceEnv: true,
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe("snapshot");
  });
});
