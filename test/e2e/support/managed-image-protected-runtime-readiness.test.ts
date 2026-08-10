// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";
import { ShellProbe } from "../fixtures/shell-probe.ts";
import {
  protectedOllamaReadinessCommand,
  protectedVllmReadinessCommand,
} from "../live/managed-image-protected-runtime-helpers.ts";

// Vitest hoists these module-scope mocks before the statically imported live-E2E command builders
// are evaluated, keeping their unavailable runtime dependencies outside this support-test boundary.
vi.mock("../../../src/lib/inference/nim.ts", () => ({
  adoptServedModelId: () => "",
  dockerLoginNgc: () => false,
  pullNimImage: () => undefined,
  startNimContainerByName: () => undefined,
  stopNimContainerByName: () => undefined,
  waitForNimHealth: () => false,
}));
vi.mock("../../../src/lib/inference/ollama/proxy.ts", () => ({
  getOllamaProxyToken: () => undefined,
  killStaleProxy: () => undefined,
  persistAndProbeOllamaProxy: async () => undefined,
  startOllamaAuthProxy: () => false,
}));
vi.mock("../fixtures/e2e-test.ts", () => ({
  expect: () => {
    throw new Error("live E2E assertions are unavailable in this support test");
  },
}));
vi.mock("../live/gpu-e2e-helpers.ts", () => ({
  assertNvidiaAvailable: () => undefined,
  cleanupOllama: async () => undefined,
  ensureOllama: async () => undefined,
  env: () => ({}),
  REPO_ROOT: process.cwd(),
}));

interface ReadinessFixture {
  artifacts: ArtifactSink;
  binDir: string;
  env: NodeJS.ProcessEnv;
  host: HostCliClient;
  root: string;
}

const fixtureRoots: string[] = [];
const fixtureProgress: TestProgress[] = [];

afterEach(() => {
  for (const progress of fixtureProgress) progress.stop();
  fixtureProgress.length = 0;
  for (const root of fixtureRoots) fs.rmSync(root, { force: true, recursive: true });
  fixtureRoots.length = 0;
});

function createReadinessFixture(): ReadinessFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-protected-readiness-"));
  fixtureRoots.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(home, ".bash_logout"), "exit 41\n", "utf8");
  writeCommand(binDir, "id", "printf '1000\\n'");
  writeCommand(binDir, "sudo", "exit 1");
  writeCommand(binDir, "systemctl", "exit 1");
  writeCommand(
    binDir,
    "setsid",
    `while [ "$#" -gt 0 ] && [ "$1" != "ollama" ]; do
  shift
done
exec "$@"`,
  );

  const artifacts = new ArtifactSink(path.join(root, "artifacts"));
  const progress = startTestProgress(
    "protected managed-image readiness support",
    ["run protected readiness command", "verify protected readiness result"],
    { logLine: () => undefined },
  );
  fixtureProgress.push(progress);
  const shellProbe = new ShellProbe({
    artifacts,
    progress,
    redact: (text) => text,
    signal: new AbortController().signal,
  });

  return {
    artifacts,
    binDir,
    env: {
      HOME: home,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    host: new HostCliClient(shellProbe),
    root,
  };
}

function writeCommand(binDir: string, name: string, body: string): void {
  const commandPath = path.join(binDir, name);
  fs.writeFileSync(commandPath, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  fs.chmodSync(commandPath, 0o755);
}

describe("protected managed-image readiness commands", () => {
  it.each([
    { kind: "relative", logPath: "ollama.log" },
    { kind: "multiline", logPath: "/tmp/ollama\r\nother.log" },
    { kind: "NUL-containing", logPath: "/tmp/ollama\0other.log" },
  ])("rejects a $kind Ollama log path", ({ logPath }) => {
    expect(() => protectedOllamaReadinessCommand(logPath)).toThrow(
      "protected Ollama log path must be absolute",
    );
  });

  it("ignores login-shell logout hooks and reports successful readiness", async () => {
    const fixture = createReadinessFixture();
    writeCommand(fixture.binDir, "ollama", "exit 0");
    writeCommand(fixture.binDir, "curl", "exit 0");

    const ollamaLog = path.join(fixture.root, "ollama.log");
    const ollamaCommand = protectedOllamaReadinessCommand(ollamaLog);
    const ollama = await fixture.host.command(ollamaCommand.command, ollamaCommand.args, {
      artifactName: "ollama-readiness-success",
      captureLimitBytes: ollamaCommand.captureLimitBytes,
      env: fixture.env,
      timeoutMs: 5_000,
    });
    const vllmCommand = protectedVllmReadinessCommand();
    const vllm = await fixture.host.command(vllmCommand.command, vllmCommand.args, {
      artifactName: "vllm-readiness-success",
      captureLimitBytes: vllmCommand.captureLimitBytes,
      env: fixture.env,
      timeoutMs: 5_000,
    });

    expect(ollama.command.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(ollama.exitCode).toBe(0);
    expect(ollama.stdout).toBe("restart_mode=manual\nmanaged-image-ollama-ready\n");
    expect(vllm.command.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(vllm.exitCode).toBe(0);
    expect(vllm.stdout).toBe("managed-image-vllm-ready attempts=1\n");
  });

  it("returns failure with a redacted tail of at most 200 Ollama log lines", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "protected-readiness-sensitive-value";
    const sourceLog = path.join(fixture.root, "ollama-source.log");
    fs.writeFileSync(
      sourceLog,
      `${Array.from(
        { length: 260 },
        (_, index) => `runtime-log-line-${String(index + 1).padStart(3, "0")} ${sensitiveValue}`,
      ).join("\n")}\n`,
      "utf8",
    );
    writeCommand(fixture.binDir, "ollama", '/bin/cat "$FAKE_OLLAMA_SOURCE_LOG"');
    writeCommand(fixture.binDir, "curl", "/bin/sleep 0.2\nexit 1");
    writeCommand(fixture.binDir, "seq", "printf '1\\n'");
    writeCommand(fixture.binDir, "sleep", "exit 0");

    const ollamaLog = path.join(fixture.root, "ollama.log");
    const command = protectedOllamaReadinessCommand(ollamaLog);
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "ollama-readiness-failure",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_OLLAMA_SOURCE_LOG: sourceLog },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });
    const diagnosticLines = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("runtime-log-line-"));

    expect(result.command.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("managed-image-ollama-not-ready status=1");
    expect(diagnosticLines).toHaveLength(200);
    expect(diagnosticLines[0]).toContain("runtime-log-line-061");
    expect(diagnosticLines.at(-1)).toContain("runtime-log-line-260");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(sensitiveValue);

    const stderrArtifact = fs.readFileSync(result.artifacts.stderr, "utf8");
    const resultArtifact = fs.readFileSync(result.artifacts.result, "utf8");
    expect(stderrArtifact).not.toContain("runtime-log-line-001");
    expect(stderrArtifact).not.toContain(sensitiveValue);
    expect(resultArtifact).not.toContain(sensitiveValue);
  });

  it("bounds one oversized Ollama log line while retaining the readiness failure", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "oversized-protected-readiness-sensitive-value";
    writeCommand(fixture.binDir, "curl", "/bin/sleep 0.2\nexit 1");
    writeCommand(fixture.binDir, "seq", "printf '1\\n'");
    writeCommand(fixture.binDir, "sleep", "exit 0");

    const ollamaLog = path.join(fixture.root, "ollama.log");
    const command = protectedOllamaReadinessCommand(ollamaLog);
    const sourceLog = path.join(fixture.root, "ollama-oversized-source.log");
    fs.writeFileSync(
      sourceLog,
      `${"x".repeat(command.captureLimitBytes + 1_024)}${sensitiveValue}\n`,
      "utf8",
    );
    writeCommand(fixture.binDir, "ollama", '/bin/cat "$FAKE_OLLAMA_SOURCE_LOG"');

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "ollama-readiness-oversized-failure",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_OLLAMA_SOURCE_LOG: sourceLog },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });
    const stderrArtifact = fs.readFileSync(result.artifacts.stderr, "utf8");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[shell-probe omitted ");
    expect(result.stderr).toContain("managed-image-ollama-not-ready status=1");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(Buffer.byteLength(stderrArtifact)).toBeLessThanOrEqual(command.captureLimitBytes + 256);
  });

  it("retains the vLLM readiness failure after oversized failing Docker logs", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "oversized-vllm-readiness-sensitive-value";
    const command = protectedVllmReadinessCommand();
    const sourceLog = path.join(fixture.root, "vllm-oversized-source.log");
    fs.writeFileSync(
      sourceLog,
      `${"x".repeat(command.captureLimitBytes + 1_024)}${sensitiveValue}\n`,
      "utf8",
    );
    writeCommand(fixture.binDir, "curl", "/bin/sleep 0.2\nexit 1");
    writeCommand(fixture.binDir, "seq", "printf '1\\n'");
    writeCommand(fixture.binDir, "sleep", "exit 0");
    writeCommand(
      fixture.binDir,
      "docker",
      `if [ "$1" = "container" ]; then
  printf 'true\\n'
  exit 0
fi
/bin/cat "$FAKE_VLLM_SOURCE_LOG"
exit 42`,
    );

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "vllm-readiness-oversized-failure",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_VLLM_SOURCE_LOG: sourceLog },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });
    const stderrArtifact = fs.readFileSync(result.artifacts.stderr, "utf8");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[shell-probe omitted ");
    expect(result.stderr).toContain("managed-image-vllm-not-ready attempts=1");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(Buffer.byteLength(stderrArtifact)).toBeLessThanOrEqual(command.captureLimitBytes + 256);
  });

  it("reports vLLM diagnostics when the container stops during readiness", async () => {
    const fixture = createReadinessFixture();
    const command = protectedVllmReadinessCommand();
    writeCommand(fixture.binDir, "curl", "exit 1");
    writeCommand(fixture.binDir, "seq", "printf '1\\n'");
    writeCommand(fixture.binDir, "sleep", "exit 99");
    writeCommand(
      fixture.binDir,
      "docker",
      `if [ "$1" = "container" ]; then
  printf 'false\\n'
  exit 0
fi
printf 'vllm-stopped-diagnostic\\n'`,
    );

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "vllm-readiness-stopped-container",
      captureLimitBytes: command.captureLimitBytes,
      env: fixture.env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vllm-stopped-diagnostic");
    expect(result.stderr).toContain("managed-image-vllm-not-ready attempts=1");
  });
});
