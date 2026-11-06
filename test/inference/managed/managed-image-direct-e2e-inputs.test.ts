// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: vi.fn(original.spawnSync) };
});

import {
  managedImageDirectNativeStartupCommand,
  managedImageStartupFailureSummary,
  parseManagedImageDirectE2eInputs,
  runManagedImageDirectE2e,
} from "../../../scripts/checks/run-managed-image-direct-e2e";
import { MANAGED_STARTUP_EXECUTABLE } from "../../../src/lib/onboard/managed-startup/hold";

const IMMUTABLE_IMAGE_ID = `sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawnSync).mockReset().mockImplementation(original.spawnSync);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed-image direct E2E inputs", () => {
  it("retains classified startup failure and attempts container removal", () => {
    const containerId = "b".repeat(64);
    const commands: string[][] = [];
    vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) => {
      commands.push([command, ...args]);
      const responses: Record<string, { status: number; stdout: string; stderr: string }> = {
        image: { status: 0, stdout: IMMUTABLE_IMAGE_ID, stderr: "" },
        run: { status: 0, stdout: containerId, stderr: "" },
        exec: { status: args.includes("test") ? 1 : 0, stdout: "", stderr: "" },
        inspect: {
          status: 0,
          stdout: JSON.stringify({
            Status: "exited",
            Running: false,
            ExitCode: 1,
            OOMKilled: false,
          }),
          stderr: "",
        },
        logs: {
          status: 0,
          stdout: "fixedHostedNativeProvider is not a function\nsynthetic-private-value",
          stderr: "",
        },
      };
      return (
        responses[command === "docker" ? args[0]! : ""] ?? { status: 0, stdout: "", stderr: "" }
      );
    }) as typeof spawnSync);
    let failure: unknown;
    try {
      runManagedImageDirectE2e({
        agent: "openclaw",
        image: IMMUTABLE_IMAGE_ID,
        platform: "linux/amd64",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('"missingProviderFunction":true');
    expect(String(failure)).toContain('"exitCode":1');
    expect(String(failure)).not.toContain("synthetic-private-value");
    expect(commands.filter((args) => args.includes("test"))).toHaveLength(60);
    expect(commands.at(-1)).toEqual(["docker", "rm", "-f", containerId]);
  });

  it("classifies startup failure without exposing container output or runtime handles", () => {
    const secret = "synthetic-private-value";
    const summary = managedImageStartupFailureSummary(
      {
        status: 0,
        stdout: JSON.stringify({
          Status: "exited",
          Running: false,
          ExitCode: 1,
          OOMKilled: false,
          Error: secret,
          Env: [`PRIVATE=${secret}`],
        }),
        stderr: secret,
      },
      {
        status: 0,
        stdout: `TypeError: fixedHostedNativeProvider is not a function\n${secret}`,
        stderr: `fixedHostedNativeProvider returned non-zero exit status 1: ${secret}`,
      },
    );
    expect(summary).toEqual({
      stateReadSucceeded: true,
      containerStatus: "exited",
      running: false,
      exitCode: 1,
      oomKilled: false,
      logsReadSucceeded: true,
      missingProviderFunction: true,
      providerRefreshFailed: true,
      managedStartupFailed: false,
      permissionDenied: false,
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    '{"Status":"private-value","Running":"false","ExitCode":"secret"}',
  ])("keeps invalid container state unknown: %s", (stdout) => {
    const summary = managedImageStartupFailureSummary(
      { status: 0, stdout, stderr: "" },
      { status: 1, stdout: "", stderr: "" },
    );
    expect(summary).toMatchObject({
      containerStatus: null,
      running: null,
      exitCode: null,
      oomKilled: null,
      logsReadSucceeded: false,
    });
    expect(JSON.stringify(summary)).not.toContain("private-value");
  });

  it("runs the native marker through the image-declared entrypoint", () => {
    expect(managedImageDirectNativeStartupCommand()).toEqual([
      MANAGED_STARTUP_EXECUTABLE,
      "/bin/sh",
      "-c",
      expect.stringContaining("nemoclaw-native-startup-uid"),
    ]);
  });

  it.each(["linux/amd64", "linux/arm64"] as const)(
    "accepts the native publication platform %s (#7744)",
    (platform) => {
      expect(
        parseManagedImageDirectE2eInputs([
          "--agent",
          "openclaw",
          "--image",
          IMMUTABLE_IMAGE_ID,
          "--platform",
          platform,
        ]),
      ).toEqual({ agent: "openclaw", image: IMMUTABLE_IMAGE_ID, platform });
    },
  );

  it("rejects platforms outside the native publication matrix", () => {
    expect(() =>
      parseManagedImageDirectE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMMUTABLE_IMAGE_ID,
        "--platform",
        "linux/s390x",
      ]),
    ).toThrow("--platform must be linux/amd64 or linux/arm64");
  });

  it("loads without the compiled CLI boundary used by the full bootstrap adapter", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-e2e-import-"));
    temporaryDirectories.push(directory);
    const hook = path.join(directory, "reject-full-adapter.cjs");
    fs.writeFileSync(
      hook,
      String.raw`
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  const value = String(request);
  if (
    value.includes("managed-bootstrap/adapter") ||
    value.includes("nemoclaw/dist/shared/sandbox-name.cjs")
  ) {
    throw new Error("forbidden protected-runtime dependency: " + value);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        hook,
        path.resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs"),
        path.resolve(
          import.meta.dirname,
          "../../../scripts/checks/run-managed-image-direct-e2e.ts",
        ),
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--agent is required");
    expect(result.stderr).not.toContain("forbidden protected-runtime dependency");
  });
});
