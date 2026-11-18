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

const DIRECT_CONTAINER_ID = "b".repeat(64);

function runDirectImageFixture(agent: string, platform: string, failProof = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-migration-"));
  temporaryDirectories.push(directory);
  const callsFile = path.join(directory, "calls.jsonl");
  const proofFile = path.join(directory, "proof.json");
  fs.writeFileSync(callsFile, "");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(
    path.join(directory, "legacy-proof.mjs"),
    String.raw`
import fs from "node:fs";
export function proveRealLegacyMigrationBridges(options) {
  fs.writeFileSync(process.env.DIRECT_PROOF_CAPTURE, JSON.stringify(options));
  if (process.env.DIRECT_PROOF_FAIL === "1") throw new Error("synthetic migration refusal");
}
`,
  );
  fs.writeFileSync(
    path.join(directory, "docker"),
    "#!/usr/bin/env node\n" +
      String.raw`
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const directory = process.env.DIRECT_FIXTURE_ROOT;
const container = "b".repeat(64);
const image = "sha256:" + "a".repeat(64);
fs.appendFileSync(process.env.DIRECT_CALLS_CAPTURE, JSON.stringify(args) + "\n");
function done(stdout = "") { process.stdout.write(stdout); process.exit(0); }
if (JSON.stringify(args) === JSON.stringify(["image", "inspect", "--format", "{{.Id}}", image])) done(image + "\n");
if (args[0] === "run" && args[args.indexOf("--platform") + 1] === process.env.DIRECT_EXPECTED_PLATFORM && args[args.indexOf("--agent") + 1] === process.env.DIRECT_EXPECTED_AGENT) done(container + "\n");
if (args[0] === "inspect") done(JSON.stringify([{ Id: container, Image: image, State: { Running: true } }]));
if (args[0] === "cp") {
  if (args[1].endsWith("/openclaw-real-legacy-migration-proof.ts")) {
    fs.writeFileSync(path.join(directory, "copied-proof"), args[2].slice(container.length + 1));
  }
  done();
}
if (args[0] === "rm") done();
if (args[0] === "exec") {
  if (args.at(-2) === "cat") done(args.at(-1).endsWith("startup-uid") ? "1000\n" : "nvidia/nemotron-3-ultra-550b-a55b\n");
  if (args.at(-2) === "-e") {
    const program = args.at(-1);
    if (program.includes("proveRealLegacyMigrationBridges(")) {
      const copied = fs.readFileSync(path.join(directory, "copied-proof"), "utf8");
      const executable = program.replaceAll("'" + copied + "'", JSON.stringify(pathToFileURL(path.join(directory, "legacy-proof.mjs")).href));
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", executable], { encoding: "utf8", env: { ...process.env, TMPDIR: directory } });
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      process.exit(result.status ?? 1);
    }
    if (program.includes("runRealOpenClawAgentReloadProof(")) done();
  }
  if (args.includes("--apply-root-stdin") || args.includes("--commit-shared-state-transaction") || args.includes("--release-startup-hold") || args.includes("test")) done();
}
process.stderr.write("Unexpected fixture Docker command: " + JSON.stringify(args));
process.exit(86);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs"),
      path.resolve(import.meta.dirname, "../../../scripts/checks/run-managed-image-direct-e2e.ts"),
      "--agent",
      agent,
      "--image",
      IMMUTABLE_IMAGE_ID,
      "--platform",
      platform,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        DIRECT_FIXTURE_ROOT: directory,
        DIRECT_EXPECTED_PLATFORM: platform,
        DIRECT_EXPECTED_AGENT: agent,
        DIRECT_CALLS_CAPTURE: callsFile,
        DIRECT_PROOF_CAPTURE: proofFile,
        DIRECT_PROOF_FAIL: failProof ? "1" : "0",
      },
    },
  );
  const calls = fs
    .readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
  const proof = fs.existsSync(proofFile)
    ? (JSON.parse(fs.readFileSync(proofFile, "utf8")) as Record<string, string>)
    : undefined;
  return { result, calls, proof };
}

function expectInstalledMigrationInvocation(fixture: ReturnType<typeof runDirectImageFixture>) {
  const destination = `${DIRECT_CONTAINER_ID}:/tmp/openclaw-real-legacy-migration-proof.ts`;
  const copy = [
    "cp",
    path.resolve(import.meta.dirname, "../../helpers/openclaw-real-legacy-migration-proof.ts"),
    destination,
  ];
  const copyIndex = fixture.calls.findIndex(
    (call) => JSON.stringify(call) === JSON.stringify(copy),
  );
  const execIndex = fixture.calls.findIndex(
    (call) => call[0] === "exec" && call.at(-1)?.includes("proveRealLegacyMigrationBridges("),
  );
  expect(copyIndex).toBeGreaterThanOrEqual(0);
  expect(execIndex).toBeGreaterThan(copyIndex);
  expect(fixture.calls[execIndex]).toEqual([
    "exec",
    "--user",
    "sandbox",
    DIRECT_CONTAINER_ID,
    "/usr/local/bin/node",
    "--input-type=module",
    "-e",
    expect.any(String),
  ]);
  expect(fixture.proof).toMatchObject({
    nodeExecutable: process.execPath,
    runtime95: "/usr/local/lib/nemoclaw/openclaw-migrations/2026.9.5/node_modules/openclaw",
    runtime97: "/usr/local/lib/nemoclaw/openclaw-migrations/2026.9.7/node_modules/openclaw",
    targetRuntime: "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw",
    migrationRunner: "/usr/local/lib/nemoclaw/openclaw-legacy-migrations.mts",
  });
  expect(fs.existsSync(fixture.proof!.home!)).toBe(false);
  expect(fixture.calls.at(-1)).toEqual(["rm", "-f", DIRECT_CONTAINER_ID]);
}

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

describe("managed-image migration execution", () => {
  it.each(["linux/amd64", "linux/arm64"])(
    "qualifies the installed OpenClaw migration runtimes on %s",
    (platform) => {
      const fixture = runDirectImageFixture("openclaw", platform);
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expectInstalledMigrationInvocation(fixture);
    },
  );

  it.each(["linux/amd64", "linux/arm64"])(
    "fails qualification when the native migration proof fails on %s",
    (platform) => {
      const fixture = runDirectImageFixture("openclaw", platform, true);
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).toContain("synthetic migration refusal");
      expect(fixture.result.stderr).toContain("Native legacy migration proof failed");
      expectInstalledMigrationInvocation(fixture);
    },
  );

  it.each(["hermes", "langchain-deepagents-code"])(
    "does not select the OpenClaw proof for %s",
    (agent) => {
      const fixture = runDirectImageFixture(agent, "linux/amd64", true);
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fixture.proof).toBeUndefined();
      expect(
        fixture.calls.some(
          (call) =>
            call[0] === "cp" && call[1]?.endsWith("/openclaw-real-legacy-migration-proof.ts"),
        ),
      ).toBe(false);
    },
  );
});
