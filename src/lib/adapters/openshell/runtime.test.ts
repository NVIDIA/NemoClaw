// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectOpenShellSandboxIdentityFingerprint } from "./sandbox-identity-cli";
import { namedOpenShellGateway } from "./sandbox-observer";
import { readCliOpenShellSandboxPolicy } from "./sandbox-policy-cli";
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

function nodeExecutable(name: string, source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-runtime-test-"));
  directories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
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

describe("sanitized OpenShell capture", () => {
  it("gives policy and identity reads the same gateway-pinned sanitized environment", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-env-test-"));
    directories.push(directory);
    const captureLog = path.join(directory, "capture.jsonl");
    const openshell = nodeExecutable(
      "openshell",
      [
        'const fs = require("node:fs");',
        'fs.appendFileSync(process.env.OPENSHELL_WORKSPACE, JSON.stringify(process.env) + "\\n");',
        'if (process.argv[2] === "policy") {',
        '  process.stdout.write("Version: 1\\nActive: 1\\n---\\nversion: 1\\nnetwork_policies: {}\\n");',
        "} else {",
        '  process.stdout.write("Name: alpha\\nID: sandbox-alpha\\n");',
        "}",
      ].join("\n"),
    );
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", openshell);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("OPENSHELL_WORKSPACE", captureLog);
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "must-not-reach-openshell");

    await expect(
      readCliOpenShellSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).resolves.toMatchObject({ result: { ok: true } });
    expect(
      inspectOpenShellSandboxIdentityFingerprint({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
      }),
    ).toHaveLength(64);

    const environments = fs
      .readFileSync(captureLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as NodeJS.ProcessEnv);
    expect(environments).toHaveLength(2);
    expect(environments[0]).toEqual(environments[1]);
    expect(environments[0]).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw",
      OPENSHELL_WORKSPACE: captureLog,
      XDG_CONFIG_HOME: path.join(directory, "config"),
    });
    expect(environments[0]).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});
