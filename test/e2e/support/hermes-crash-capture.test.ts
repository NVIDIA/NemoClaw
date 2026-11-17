// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureHermesCrash, hermesCrashCaptureArgs } from "../fixtures/hermes-crash-capture.ts";
import type { DockerCommandResult } from "../fixtures/docker-probe.ts";
import { ShellProbe, trustedShellCommand, type ShellProbeResult } from "../fixtures/shell-probe.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";

const container = "nemoclaw-hermes-root-clean-test";
const image = `sha256:${"a".repeat(64)}`;
const processIdentity = { pid: 707, executable: "/usr/local/bin/python3.13" };
const result = (
  exitCode = 139,
  stdout = `NEMOCLAW_HERMES_CRASH_PROCESS=${JSON.stringify(processIdentity)}\n`,
): DockerCommandResult => ({
  command: ["docker", "exec", container],
  exitCode,
  signal: null,
  stdout,
  stderr: "",
});
const debuggerResult = (exitCode = 0): ShellProbeResult => ({
  command: [],
  exitCode,
  signal: null,
  timedOut: false,
  stdout: "#0 fault",
  stderr: "",
  artifacts: {
    stdout: "stack.stdout.txt",
    stderr: "stack.stderr.txt",
    result: "stack.result.json",
  },
});
const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-crash-test-"));
  temporaryRoots.push(root);
  vi.stubEnv("RUNNER_TEMP", root);
  let corePath = "";
  const docker = {
    run: vi
      .fn(async (args: string[]) => {
        corePath = args[2]!;
        fs.writeFileSync(corePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
        return result(0, "");
      })
      .mockResolvedValueOnce(result(0, `321 ${image}\n`)),
  };
  const shell = {
    run: vi.fn<ShellProbe["run"]>(async () => debuggerResult()),
  };
  const artifacts = { writeJson: vi.fn(async () => "capture.json") };
  return { root, docker, shell, artifacts, corePath: () => corePath };
}

describe("Hermes passive crash capture", () => {
  it("leaves ordinary and non-Linux runs unchanged", () => {
    expect(hermesCrashCaptureArgs({}, "linux")).toEqual([]);
    expect(hermesCrashCaptureArgs({ NEMOCLAW_HERMES_CRASH_CAPTURE: "1" }, "linux")).toEqual([]);
    expect(
      hermesCrashCaptureArgs(
        { NEMOCLAW_HERMES_CRASH_CAPTURE: "1", GITHUB_ACTIONS: "true" },
        "darwin",
      ),
    ).toEqual([]);
    expect(
      hermesCrashCaptureArgs(
        { NEMOCLAW_HERMES_CRASH_CAPTURE: "1", GITHUB_ACTIONS: "true" },
        "linux",
      ),
    ).toEqual([
      "--ulimit",
      "core=0:268435456",
      "--env",
      "NEMOCLAW_HERMES_CRASH_CAPTURE=1",
      "--label",
      "io.nvidia.nemoclaw.hermes-crash-capture=1",
    ]);
  });

  it("records a successful exit without invoking a debugger or copying memory", async () => {
    const h = harness();
    await captureHermesCrash({ ...h, container, result: result(0) });
    expect(h.docker.run).not.toHaveBeenCalled();
    expect(h.shell.run).not.toHaveBeenCalled();
    expect(h.artifacts.writeJson).toHaveBeenCalledWith(
      "hermes-crash-capture.json",
      expect.objectContaining({ probeExitCode: 0, state: "not-a-core-signal" }),
    );
    expect(fs.readdirSync(h.root)).toEqual([]);
  });

  it("captures bounded stacks without arguments or auto-loaded code and removes the private core", async () => {
    const h = harness();
    const original = result();
    await captureHermesCrash({ ...h, container, result: original });
    expect(original.exitCode).toBe(139);
    expect(h.docker.run.mock.calls[1]?.[0]).toEqual([
      "cp",
      `${container}:/tmp/nemoclaw-hermes-crash/core.707`,
      h.corePath(),
    ]);
    expect(h.shell.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/usr/bin/sudo",
        args: [
          "-n",
          "/usr/bin/timeout",
          "--signal=TERM",
          "--kill-after=2s",
          "25s",
          "/usr/bin/gdb",
          "-nx",
          "-nh",
          "-batch",
          "-iex",
          "set auto-load off",
          "-iex",
          "set debuginfod enabled off",
          "-iex",
          "set print frame-arguments none",
          "-ex",
          "set sysroot /proc/321/root",
          "-ex",
          "file /proc/321/root/usr/local/bin/python3.13",
          "-ex",
          `core-file ${h.corePath()}`,
          "-ex",
          "set $hermes_fault_thread = $_thread",
          "-ex",
          "bt 32",
          "-ex",
          "p/x $pc",
          "-ex",
          "x/i $pc",
          "-ex",
          "info threads",
          "-ex",
          "thread apply all bt 32",
          "-ex",
          "info sharedlibrary",
          "-ex",
          "info proc mappings",
          "-ex",
          "info files",
          "-ex",
          'eval "thread %d", $hermes_fault_thread',
          "-ex",
          "frame 0",
          "-ex",
          "bt 32",
          "-ex",
          "p/x $pc",
          "-ex",
          "x/i $pc",
        ],
      }),
      expect.objectContaining({
        timeoutMs: 30000,
        captureLimitBytes: 524288,
        env: { PATH: "/usr/bin:/bin", HOME: expect.any(String) },
      }),
    );
    expect(h.artifacts.writeJson).toHaveBeenCalledWith(
      "hermes-crash-capture.json",
      expect.objectContaining({
        state: "captured",
        probeExitCode: 139,
        image,
        privateCoreCleanup: "removed",
      }),
    );
    expect(fs.existsSync(h.corePath())).toBe(false);
    expect(fs.readdirSync(h.root)).toEqual([]);
  });

  it("retains the faulting stack and instruction when intermediate debugger output exceeds the cap", async () => {
    const h = harness();
    const artifacts = new ArtifactSink(path.join(h.root, "artifacts"));
    const progress = startTestProgress(
      "crash output retention",
      ["emit synthetic debugger output", "verify retained fault evidence"],
      { logLine: () => undefined },
    );
    const realShell = new ShellProbe({
      artifacts,
      progress,
      redact: (text) => text,
      signal: new AbortController().signal,
    });
    const output: ShellProbeResult[] = [];
    h.shell.run.mockImplementationOnce(async (command, options) => {
      const captured = await realShell.run(
        trustedShellCommand({
          command: process.execPath,
          args: [
            "-e",
            String.raw`
          const fs = require('node:fs');
          const args = JSON.parse(process.argv[1]);
          for (let i = 0; i < args.length; i++) {
            if (args[i] !== '-ex') continue;
            const command = args[++i];
            if (command === 'info files') fs.writeSync(1, 'metadata\n'.repeat(100000));
            if (command === 'bt 32' || command === 'thread apply all bt 32') fs.writeSync(1, 'FAULT-STACK\n');
            if (command === 'p/x $pc') fs.writeSync(1, 'FAULT-PC\n');
            if (command === 'x/i $pc') fs.writeSync(1, 'FAULT-INSTRUCTION\n');
          }
        `,
            JSON.stringify(command.args),
          ],
          reason:
            "Model debugger output ordering through the real bounded ShellProbe without GDB, a crash, or host privilege",
        }),
        options,
      );
      output.push(captured);
      return captured;
    });
    try {
      await captureHermesCrash({ ...h, container, result: result() });
      expect(output).toHaveLength(1);
      const text = fs.readFileSync(output[0]!.artifacts.stdout, "utf8");
      expect(text).toContain("[shell-probe omitted ");
      expect(Buffer.byteLength(text)).toBeLessThan(524288 + 128);
      const tail = text.slice(-1024);
      expect(tail).toMatch(/FAULT-PC\nFAULT-INSTRUCTION\n$/);
      expect(tail).toContain("FAULT-STACK");
      expect(fs.existsSync(h.corePath())).toBe(false);
    } finally {
      progress.stop();
    }
  });

  it.each([
    { kind: "missing", copy: async (_args: string[]) => result(1, "") },
    {
      kind: "symlink",
      copy: async (args: string[]) => {
        fs.symlinkSync("missing-target", args[2]!);
        return result(0, "");
      },
    },
    {
      kind: "oversized",
      copy: async (args: string[]) => {
        fs.writeFileSync(args[2]!, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
        fs.truncateSync(args[2]!, 268435457);
        return result(0, "");
      },
    },
  ])("rejects a $kind core without debugger execution", async ({ copy }) => {
    const h = harness();
    h.docker.run.mockImplementationOnce(copy);
    await captureHermesCrash({ ...h, container, result: result() });
    expect(h.shell.run).not.toHaveBeenCalled();
    expect(h.artifacts.writeJson).toHaveBeenCalledWith(
      "hermes-crash-capture.json",
      expect.objectContaining({
        state: "capture-failed",
        probeExitCode: 139,
        privateCoreCleanup: "removed",
      }),
    );
    expect(fs.readdirSync(h.root)).toEqual([]);
  });

  it.each([
    { pid: -1, executable: "/usr/bin/python" },
    { pid: 707, executable: "/usr/bin/python\nquit" },
    { pid: 707, executable: "/usr/../etc/passwd" },
  ])("rejects unsafe process identity before host access: %j", async (identity) => {
    const h = harness();
    await captureHermesCrash({
      ...h,
      container,
      result: result(139, `NEMOCLAW_HERMES_CRASH_PROCESS=${JSON.stringify(identity)}\n`),
    });
    expect(h.docker.run).not.toHaveBeenCalled();
    expect(h.shell.run).not.toHaveBeenCalled();
  });

  it("does not copy memory into the uploaded artifact root", async () => {
    const h = harness();
    vi.stubEnv("E2E_ARTIFACT_DIR", h.root);
    await captureHermesCrash({ ...h, container, result: result() });
    expect(h.docker.run).toHaveBeenCalledTimes(1);
    expect(h.shell.run).not.toHaveBeenCalled();
    expect(fs.readdirSync(h.root)).toEqual([]);
  });

  it.each(["0", "1", "2147483648", "321\nquit"])(
    "rejects host PID %s before copying memory",
    async (pid) => {
      const h = harness();
      h.docker.run.mockReset().mockResolvedValueOnce(result(0, `${pid} ${image}`));
      await captureHermesCrash({ ...h, container, result: result() });
      expect(h.docker.run).toHaveBeenCalledTimes(1);
      expect(h.shell.run).not.toHaveBeenCalled();
      expect(fs.readdirSync(h.root)).toEqual([]);
    },
  );

  it.each([1, 124, 137])(
    "keeps memory private and records incomplete debugger status %s",
    async (exitCode) => {
      const h = harness();
      h.shell.run.mockImplementationOnce(async () => {
        expect(fs.statSync(path.dirname(h.corePath())).mode & 0o777).toBe(0o700);
        expect(fs.statSync(h.corePath()).mode & 0o777).toBe(0o600);
        return debuggerResult(exitCode);
      });
      await captureHermesCrash({ ...h, container, result: result(134) });
      expect(h.artifacts.writeJson).toHaveBeenCalledWith(
        "hermes-crash-capture.json",
        expect.objectContaining({
          state: "capture-incomplete",
          probeExitCode: 134,
          gdbExitCode: exitCode,
          privateCoreCleanup: "removed",
        }),
      );
      expect(fs.readdirSync(h.root)).toEqual([]);
    },
  );

  it("does not replace the original failure when the diagnostic artifact cannot be written", async () => {
    const h = harness();
    h.artifacts.writeJson.mockRejectedValueOnce(new Error("artifact unavailable"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const original = result();
    await expect(
      captureHermesCrash({ ...h, container, result: original }),
    ).resolves.toBeUndefined();
    expect(original.exitCode).toBe(139);
    expect(fs.readdirSync(h.root)).toEqual([]);
  });

  it("preserves the failed probe when debugger execution is interrupted and still removes memory", async () => {
    const h = harness();
    h.shell.run.mockRejectedValueOnce(new Error("cancelled"));
    const original = result();
    await captureHermesCrash({ ...h, container, result: original });
    expect(original.exitCode).toBe(139);
    expect(h.artifacts.writeJson).toHaveBeenCalledWith(
      "hermes-crash-capture.json",
      expect.objectContaining({ state: "capture-failed", privateCoreCleanup: "removed" }),
    );
    expect(fs.readdirSync(h.root)).toEqual([]);
  });
});
