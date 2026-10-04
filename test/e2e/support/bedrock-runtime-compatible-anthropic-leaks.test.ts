// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import {
  BEDROCK_LEAK_PROBE_SOURCE,
  type BedrockLeakProbeInput,
  type ForbiddenLeakPattern,
  createBedrockForbiddenLeakPatterns,
  createBedrockLeakProbeExecArgs,
  createBedrockLeakProbeInput,
  parseBedrockLeakProbeResult,
} from "../live/bedrock-runtime-compatible-anthropic-leaks.ts";
import { runRawCommand } from "../live/bedrock-runtime-compatible-anthropic-raw-command.ts";

const SECRET = "representative-bedrock-secret-value";
const PATTERNS: readonly ForbiddenLeakPattern[] = [{ name: "test secret", value: SECRET }];
const temporaryRoots: string[] = [];

interface ProbeFixture {
  readonly root: string;
  readonly credentialFile: string;
  readonly configFile: string;
  readonly environFile: string;
  readonly cmdlineFile: string;
  readonly input: BedrockLeakProbeInput;
}

function createProbeFixture(): ProbeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-leak-probe-"));
  temporaryRoots.push(root);
  const credentialFile = path.join(root, "credential.env");
  const configFile = path.join(root, "config.yaml");
  const procRoot = path.join(root, "proc");
  const processRoot = path.join(procRoot, "101");
  const environFile = path.join(processRoot, "environ");
  const cmdlineFile = path.join(processRoot, "cmdline");
  fs.mkdirSync(processRoot, { recursive: true });
  fs.writeFileSync(credentialFile, "CREDENTIAL=placeholder\n");
  fs.writeFileSync(configFile, "provider: inference\n");
  fs.writeFileSync(environFile, "PATH=/usr/bin\0");
  fs.writeFileSync(cmdlineFile, "python3\0worker.py\0");
  return {
    root,
    credentialFile,
    configFile,
    environFile,
    cmdlineFile,
    input: createBedrockLeakProbeInput(PATTERNS, {
      credentialFiles: [credentialFile],
      configFiles: [configFile],
      procRoot,
    }),
  };
}

function runProbe(input: string | BedrockLeakProbeInput): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync("python3", ["-I", "-c", BEDROCK_LEAK_PROBE_SOURCE], {
    encoding: "utf8",
    input: typeof input === "string" ? input : JSON.stringify(input),
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function createFifo(file: string): void {
  const result = spawnSync("mkfifo", [file], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function progressProbe() {
  const progress = startTestProgress(
    "Bedrock leak probe support",
    ["prepare bounded boundaries", "scan bounded boundaries"],
    {
      clearTimer: () => undefined,
      logLine: () => undefined,
      now: () => 0,
      setTimer: () => ({}),
    },
  );
  onTestFinished(() => progress.stop());
  return progress;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fsPromises.rm(root, { force: true, recursive: true })),
  );
});

describe("Bedrock Runtime bounded leak probe", () => {
  it("uses the pinned OpenShell piped-stdin command contract (#12191)", () => {
    const args = createBedrockLeakProbeExecArgs("e2e-bedrock");

    expect(args.slice(0, -1)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "e2e-bedrock",
      "--",
      "python3",
      "-I",
      "-c",
    ]);
    expect(args).not.toContain("--stdin");
    expect(args.at(-1)).toBe(BEDROCK_LEAK_PROBE_SOURCE);
  });

  it("reports bounded clean metadata for every required sandbox boundary (#12191)", () => {
    const fixture = createProbeFixture();
    const result = runProbe(fixture.input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.status).toBe("clean");
    expect(parsed.categories).toEqual({
      credentialFiles: {
        status: "clean",
        itemsScanned: 1,
        bytesScanned: Buffer.byteLength("CREDENTIAL=placeholder\n"),
        matches: [],
        errors: [],
      },
      configFiles: {
        status: "clean",
        itemsScanned: 1,
        bytesScanned: Buffer.byteLength("provider: inference\n"),
        matches: [],
        errors: [],
      },
      processEnvironment: {
        status: "clean",
        itemsScanned: 1,
        bytesScanned: Buffer.byteLength("PATH=/usr/bin\0"),
        matches: [],
        errors: [],
      },
      processArguments: {
        status: "clean",
        itemsScanned: 1,
        bytesScanned: Buffer.byteLength("python3\0worker.py\0"),
        matches: [],
        errors: [],
      },
    });
    expect(JSON.stringify(fixture.input)).not.toContain(SECRET);
    expect(result.stdout).not.toContain(SECRET);
  });

  it.each([
    ["credential file", "credentialFile", "credentialFiles"],
    ["config file", "configFile", "configFiles"],
    ["process environment", "environFile", "processEnvironment"],
    ["process arguments", "cmdlineFile", "processArguments"],
  ] as const)(
    "returns match-only evidence for an injected %s leak (#12191)",
    (_label, fixtureKey, category) => {
      const fixture = createProbeFixture();
      fs.appendFileSync(fixture[fixtureKey], SECRET);

      const result = runProbe(fixture.input);
      const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

      expect(result.status).toBe(3);
      expect(parsed.status).toBe("leak");
      expect(parsed.categories[category]).toMatchObject({
        status: "leak",
        matches: ["test secret"],
        errors: [],
      });
      expect(result.stdout).not.toContain(SECRET);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(32 * 1024);
    },
  );

  it("fails closed when a required file boundary is absent (#12191)", () => {
    const fixture = createProbeFixture();
    fs.rmSync(fixture.credentialFile);

    const result = runProbe(fixture.input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(2);
    expect(parsed.status).toBe("error");
    expect(parsed.categories.credentialFiles).toMatchObject({
      status: "error",
      itemsScanned: 0,
      matches: [],
      errors: ["required-file-boundary-empty", "required-file-missing"],
    });
  });

  it("fails closed when one requested config is missing beside a readable config (#12191)", () => {
    const fixture = createProbeFixture();
    const input = {
      ...fixture.input,
      configFiles: [fixture.configFile, path.join(fixture.root, "missing-config.json")],
    };

    const result = runProbe(input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(2);
    expect(parsed.categories.configFiles).toMatchObject({
      status: "error",
      itemsScanned: 1,
      errors: ["required-file-missing"],
    });
  });

  it("fails closed when a requested config is replaced by a symbolic link (#12191)", () => {
    const fixture = createProbeFixture();
    const replacement = path.join(fixture.root, "replacement.yaml");
    fs.writeFileSync(replacement, "provider: replacement\n");
    fs.rmSync(fixture.configFile);
    fs.symlinkSync(replacement, fixture.configFile);

    const result = runProbe(fixture.input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(2);
    expect(parsed.categories.configFiles).toMatchObject({
      status: "error",
      itemsScanned: 0,
      errors: ["required-file-boundary-empty", "unsafe-file-boundary"],
    });
  });

  it("fails closed without blocking when a requested config is replaced by a FIFO (#12191)", () => {
    const fixture = createProbeFixture();
    fs.rmSync(fixture.configFile);
    createFifo(fixture.configFile);

    const result = runProbe(fixture.input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(2);
    expect(parsed.categories.configFiles).toMatchObject({
      status: "error",
      itemsScanned: 0,
      errors: ["required-file-boundary-empty", "unsafe-file-boundary"],
    });
  });

  it("fails closed when no process member is readable (#12191)", () => {
    const fixture = createProbeFixture();
    fs.rmSync(fixture.environFile);
    fs.mkdirSync(fixture.environFile);

    const result = runProbe(fixture.input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(2);
    expect(parsed.categories.processEnvironment).toMatchObject({
      status: "error",
      itemsScanned: 0,
      errors: ["required-process-boundary-empty"],
    });
  });

  it("ignores unreadable process entries while scanning every sandbox-readable entry (#12191)", () => {
    const fixture = createProbeFixture();
    const unrelatedRoot = path.join(fixture.input.procRoot, "202");
    fs.mkdirSync(path.join(unrelatedRoot, "environ"), { recursive: true });
    fs.mkdirSync(path.join(unrelatedRoot, "cmdline"));

    const result = runProbe(fixture.input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe("clean");
    expect(parsed.categories.processEnvironment.itemsScanned).toBe(1);
    expect(parsed.categories.processArguments.itemsScanned).toBe(1);
  });

  it("fails closed at the per-file byte limit without publishing file content (#12191)", () => {
    const fixture = createProbeFixture();
    fs.writeFileSync(fixture.configFile, Buffer.alloc(1024 * 1024 + 1, 65));

    const result = runProbe(fixture.input);
    const parsed = parseBedrockLeakProbeResult(result.stdout, PATTERNS);

    expect(result.status).toBe(2);
    expect(parsed.categories.configFiles).toMatchObject({
      status: "error",
      errors: ["file-item-limit-exceeded", "required-file-boundary-empty"],
    });
    expect(result.stdout).not.toContain("A".repeat(64));
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(32 * 1024);
  });

  it("rejects oversized input and forged result counts (#12191)", () => {
    const fixture = createProbeFixture();
    const tooManyPatterns = Array.from({ length: 17 }, (_, index) => ({
      name: `secret ${index}`,
      value: `value-${index}-long-enough`,
    }));
    expect(() =>
      createBedrockLeakProbeInput(tooManyPatterns, {
        credentialFiles: [fixture.credentialFile],
        configFiles: [fixture.configFile],
        procRoot: fixture.input.procRoot,
      }),
    ).toThrow("between 1 and 16");

    const oversizedPatterns = [{ name: "oversized secret", value: "x".repeat(4097) }];
    expect(() =>
      createBedrockLeakProbeInput(oversizedPatterns, {
        credentialFiles: [fixture.credentialFile],
        configFiles: [fixture.configFile],
        procRoot: fixture.input.procRoot,
      }),
    ).toThrow("8 to 4096");
    expect(() =>
      createBedrockLeakProbeInput(PATTERNS, {
        credentialFiles: [`/${"x".repeat(32_768)}`],
        configFiles: [fixture.configFile],
        procRoot: fixture.input.procRoot,
      }),
    ).toThrow("input exceeded its byte limit");

    const clean = runProbe(fixture.input);
    const forged = JSON.parse(clean.stdout) as {
      categories: { configFiles: { bytesScanned: number } };
    };
    forged.categories.configFiles.bytesScanned = 2_097_153;
    expect(() => parseBedrockLeakProbeResult(JSON.stringify(forged), PATTERNS)).toThrow(
      "invalid byte count",
    );
  });

  it("rejects forged fingerprint checksums and bounds total scan work (#12191)", () => {
    const fixture = createProbeFixture();
    const forgedInput = JSON.parse(JSON.stringify(fixture.input)) as {
      patterns: Array<{ byteSum: number }>;
    };
    forgedInput.patterns[0]!.byteSum = -1;

    const rejected = runProbe(JSON.stringify(forgedInput));
    expect(rejected.status).toBe(2);
    expect(parseBedrockLeakProbeResult(rejected.stdout, PATTERNS).status).toBe("error");

    const scanPatterns = Array.from({ length: 16 }, (_, index) => ({
      name: `scan secret ${index}`,
      value: `bounded-secret-${index}`,
    }));
    fs.writeFileSync(fixture.configFile, Buffer.alloc(600_000, 65));
    const boundedInput = createBedrockLeakProbeInput(scanPatterns, {
      credentialFiles: [fixture.credentialFile],
      configFiles: [fixture.configFile],
      procRoot: fixture.input.procRoot,
    });
    const bounded = runProbe(boundedInput);
    const parsed = parseBedrockLeakProbeResult(bounded.stdout, scanPatterns);

    expect(bounded.status).toBe(2);
    expect(parsed.categories.configFiles.errors).toContain("scan-work-limit-exceeded");
  });

  it("keeps the exact live forbidden-value labels compatible with the probe schema (#12191)", () => {
    const fixture = createProbeFixture();
    const patterns = createBedrockForbiddenLeakPatterns({
      adapterToken: "representative-adapter-token",
      bedrockHostname: "bedrock-runtime.us-east-1.amazonaws.com",
      compatibleKey: "representative-compatible-key",
    });

    expect(() =>
      createBedrockLeakProbeInput(patterns, {
        credentialFiles: [fixture.credentialFile],
        configFiles: [fixture.configFile],
        procRoot: fixture.input.procRoot,
      }),
    ).not.toThrow();
    expect(patterns.map(({ name }) => name)).toEqual([
      "fake user key",
      "adapter token",
      "aws bearer env name",
      "adapter token env name",
      "raw bedrock hostname",
    ]);
  });

  it("rejects malformed input and forged multi-record output (#12191)", () => {
    const malformed = runProbe(`{"version":1}\n${SECRET}`);
    const oversized = runProbe("x".repeat(32_769));

    expect(malformed.status).toBe(2);
    expect(malformed.stdout).not.toContain(SECRET);
    expect(parseBedrockLeakProbeResult(malformed.stdout, PATTERNS).status).toBe("error");
    expect(oversized.status).toBe(2);
    expect(oversized.stdout).toContain("input-limit-exceeded");

    const fixture = createProbeFixture();
    const clean = runProbe(fixture.input);
    expect(() =>
      parseBedrockLeakProbeResult(`${clean.stdout.trim()}\n${clean.stdout.trim()}\n`, PATTERNS),
    ).toThrow("single-record bound");
  });

  it("keeps fingerprint input and raw values out of raw-command artifacts (#12191)", async () => {
    const fixture = createProbeFixture();
    fs.appendFileSync(fixture.credentialFile, SECRET);
    const artifactRoot = path.join(fixture.root, "artifacts");
    const artifacts = new ArtifactSink(artifactRoot);
    await artifacts.ensureRoot();

    const result = await runRawCommand("python3", ["-I", "-c", BEDROCK_LEAK_PROBE_SOURCE], {
      artifactName: "bounded-leak-probe",
      artifacts,
      progress: progressProbe(),
      redactionValues: [SECRET],
      stdin: JSON.stringify(fixture.input),
    });

    expect(result.exitCode).toBe(3);
    expect(parseBedrockLeakProbeResult(result.stdout, PATTERNS).status).toBe("leak");
    const artifactFiles = [
      "raw-shell/bounded-leak-probe.stdout.txt",
      "raw-shell/bounded-leak-probe.stderr.txt",
      "raw-shell/bounded-leak-probe.result.json",
    ];
    const published = (
      await Promise.all(
        artifactFiles.map((file) => fsPromises.readFile(path.join(artifactRoot, file), "utf8")),
      )
    ).join("\n");
    expect(published).not.toContain(SECRET);
    expect(published).not.toContain(fixture.input.patterns[0]?.sha256);
    expect(published).toContain('"test secret"');
  });

  it("preserves the child result when the child closes stdin early (#12191)", async () => {
    const fixture = createProbeFixture();
    const artifactRoot = path.join(fixture.root, "early-stdin-artifacts");
    const artifacts = new ArtifactSink(artifactRoot);
    await artifacts.ensureRoot();

    const result = await runRawCommand(
      process.execPath,
      ["-e", "process.stdin.destroy(); process.exit(0);"],
      {
        artifactName: "early-stdin-close",
        artifacts,
        progress: progressProbe(),
        stdin: "x".repeat(8 * 1024 * 1024),
      },
    );

    expect(result.exitCode).toBe(0);
    await expect(
      fsPromises.readFile(
        path.join(artifactRoot, "raw-shell/early-stdin-close.result.json"),
        "utf8",
      ),
    ).resolves.toContain('"exitCode": 0');
  });
});
