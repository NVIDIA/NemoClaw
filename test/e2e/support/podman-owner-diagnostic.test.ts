// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import {
  observeWithOwnerDiagnostic,
  withPodmanOwnerDiagnostic,
} from "../fixtures/podman-owner-diagnostic";
const unavailable = { kind: "podman-owner-observation-v1", source: "unavailable" } as const;
it.each([true, false])("preserves exact observer and input, verified=%s", (verified) => {
  const result = {
    listenerScan: { pids: verified ? [12] : [], unverifiedPids: verified ? [] : [12] },
  };
  const original = vi.fn(() => result);
  const capture = vi.fn();
  const input = {};
  const facts = { kind: "podman-owner-snapshot-v1", available: false } as const;
  const snapshot = vi.fn(() => facts);
  const wrapped = observeWithOwnerDiagnostic(
    { observeOwnedGateway: original } as never,
    capture,
    snapshot,
  );
  expect(wrapped.observeOwnedGateway(input as never)).toBe(result);
  expect(original).toHaveBeenCalledExactlyOnceWith(input);
  expect(snapshot).toHaveBeenCalledExactlyOnceWith(input, 12);
  expect(capture).toHaveBeenCalledExactlyOnceWith({
    kind: "podman-owner-observation-v1",
    source: verified ? "verified" : "unverified",
    facts,
  });
});
it("does not snapshot ambiguous listeners", () => {
  const result = { listenerScan: { pids: [12], unverifiedPids: [99] } };
  const snapshot = vi.fn();
  const capture = vi.fn();
  expect(
    observeWithOwnerDiagnostic(
      { observeOwnedGateway: () => result } as never,
      capture,
      snapshot,
    ).observeOwnedGateway({} as never),
  ).toBe(result);
  expect(snapshot).not.toHaveBeenCalled();
  expect(capture).toHaveBeenCalledExactlyOnceWith(unavailable);
});
it("preserves original observer errors", () => {
  const error = new Error("secret");
  const capture = vi.fn();
  const wrapper = observeWithOwnerDiagnostic(
    {
      observeOwnedGateway: () => {
        throw error;
      },
    } as never,
    capture,
  );
  expect(() => wrapper.observeOwnedGateway({} as never)).toThrow(error);
  expect(capture).not.toHaveBeenCalled();
});
it("preserves command return despite diagnostic write failure", async () => {
  const result = {};
  const phases: string[] = [];
  const write = async (phase: string) => {
    phases.push(phase);
    throw new Error("secret");
  };
  expect(
    await withPodmanOwnerDiagnostic(
      {},
      write,
      async () => result,
      async () => unavailable,
    ),
  ).toBe(result);
  expect(phases).toEqual(["before", "after"]);
});
it("records after failed command and preserves outer cleanup", async () => {
  const error = new Error("scenario");
  const cleanup = vi.fn();
  const phases: string[] = [];
  const scenario = async () => {
    try {
      await withPodmanOwnerDiagnostic(
        {},
        async (phase) => {
          phases.push(phase);
        },
        async () => {
          throw error;
        },
        async () => unavailable,
      );
    } finally {
      cleanup();
    }
  };
  await expect(scenario()).rejects.toBe(error);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(phases).toEqual(["before", "after"]);
});

it("treats bounded child timeout as unavailable", async () => {
  const { captureBoundedPodmanOwnerDiagnostic } =
    await import("../fixtures/podman-owner-diagnostic");
  const command = vi.fn(async () => ({
    exitCode: null,
    timedOut: true,
    stdout: "private",
    stderr: "private",
  }));
  expect(await captureBoundedPodmanOwnerDiagnostic({ command } as never, {}, "before")).toEqual(
    unavailable,
  );
  expect(command).toHaveBeenCalledWith(
    process.execPath,
    expect.any(Array),
    expect.objectContaining({
      timeoutMs: 60_000,
      persistArtifacts: false,
      captureLimitBytes: 4096,
    }),
  );
});

it("canonical child boundary kills a timed-out diagnostic before outer cleanup", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ShellProbe, trustedShellCommand } = await import("../fixtures/shell-probe");
  const { ArtifactSink } = await import("../fixtures/artifacts");
  const { startTestProgress } = await import("../fixtures/progress");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-diagnostic-timeout-"));
  const progress = startTestProgress(
    "owner diagnostic timeout",
    ["run bounded diagnostic", "verify cleanup"],
    { logLine: () => undefined },
  );
  try {
    const probe = new ShellProbe({
      artifacts: new ArtifactSink(directory),
      progress,
      redact: (text) => text,
      signal: new AbortController().signal,
    });
    const result = await probe.run(
      trustedShellCommand({
        command: process.execPath,
        args: ["-e", "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"],
        reason: "prove bounded diagnostic cleanup",
      }),
      { timeoutMs: 200, killGraceMs: 50 },
    );
    expect(result.timedOut).toBe(true);
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  expect(fs.existsSync(directory)).toBe(false);
});

it.each([
  { stdout: "secret malformed stdout", stderr: "" },
  { stdout: JSON.stringify(unavailable), stderr: "private loader failure" },
  { stdout: "x".repeat(4097), stderr: "" },
  { stdout: JSON.stringify({ ...unavailable, privateKey: "secret" }), stderr: "" },
])("publishes only unavailable for untrusted child output", async (output) => {
  const { captureBoundedPodmanOwnerDiagnostic } =
    await import("../fixtures/podman-owner-diagnostic");
  const command = vi.fn(async () => ({ exitCode: 0, timedOut: false, ...output }));
  const result = await captureBoundedPodmanOwnerDiagnostic({ command } as never, {}, "after");
  expect(result).toEqual(unavailable);
  expect(command).toHaveBeenCalledWith(
    process.execPath,
    expect.any(Array),
    expect.objectContaining({ persistArtifacts: false, captureLimitBytes: 4096 }),
  );
});

it("canonical runner does not persist raw diagnostic stdout stderr or result", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ShellProbe, trustedShellCommand } = await import("../fixtures/shell-probe");
  const { ArtifactSink } = await import("../fixtures/artifacts");
  const { startTestProgress } = await import("../fixtures/progress");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-diagnostic-private-"));
  const progress = startTestProgress(
    "private owner diagnostic",
    ["run diagnostic", "verify no raw artifacts"],
    { logLine: () => undefined },
  );
  try {
    const sink = new ArtifactSink(directory);
    const probe = new ShellProbe({
      artifacts: sink,
      progress,
      redact: (text) => text,
      signal: new AbortController().signal,
    });
    const result = await probe.run(
      trustedShellCommand({
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeSync(1,'private stdout'.repeat(500)); require('node:fs').writeSync(2,'private stderr')",
        ],
        reason: "verify raw diagnostics never persist",
      }),
      { persistArtifacts: false, captureLimitBytes: 4096, timeoutMs: 5000 },
    );
    expect(result.stdout).toContain("private stdout");
    expect(result.stdout.length).toBeLessThan(5000);
    expect(result.stderr).toBe("private stderr");
    expect(result.artifacts).toEqual({ stdout: "", stderr: "", result: "" });
    expect(fs.readdirSync(directory)).toEqual([]);
    await sink.writeJson("validated-owner.json", unavailable);
    expect(fs.readdirSync(directory)).toEqual(["validated-owner.json"]);
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, "validated-owner.json"), "utf8")),
    ).toEqual(unavailable);
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  expect(fs.existsSync(directory)).toBe(false);
});

it.each([
  { available: true },
  { kind: "podman-owner-snapshot-v1", available: "podman-owner-snapshot-v1" },
  { kind: "wrong", available: false },
  { kind: "podman-owner-snapshot-v1", available: true },
  { kind: "podman-owner-snapshot-v1", available: false, markerParsed: true },
  null,
])("rejects malformed fact schemas", async (facts) => {
  const { captureBoundedPodmanOwnerDiagnostic } =
    await import("../fixtures/podman-owner-diagnostic");
  const command = async () => ({
    exitCode: 0,
    timedOut: false,
    stderr: "",
    stdout: JSON.stringify({ kind: unavailable.kind, source: "verified", facts }),
  });
  expect(await captureBoundedPodmanOwnerDiagnostic({ command } as never, {}, "before")).toEqual(
    unavailable,
  );
});

it("accepts the exact unavailable-facts variant", async () => {
  const { captureBoundedPodmanOwnerDiagnostic } =
    await import("../fixtures/podman-owner-diagnostic");
  const report = {
    kind: unavailable.kind,
    source: "unverified",
    facts: { kind: "podman-owner-snapshot-v1", available: false },
  };
  const command = async () => ({
    exitCode: 0,
    timedOut: false,
    stderr: "",
    stdout: JSON.stringify(report),
  });
  expect(await captureBoundedPodmanOwnerDiagnostic({ command } as never, {}, "after")).toEqual(
    report,
  );
});

it("accepts a complete boolean fact report", async () => {
  const { captureBoundedPodmanOwnerDiagnostic } =
    await import("../fixtures/podman-owner-diagnostic");
  const fields = [
    "available",
    "pidFileReadable",
    "pidFileMatchesListener",
    "markerReadable",
    "markerParsed",
    "markerMatchesListener",
    "markerIsPodman",
    "markerPlatformMatchesExpected",
    "markerArchitectureMatchesExpected",
    "markerEndpointMatchesExpected",
    "trustedExecutableResolved",
    "markerExecutableMatchesTrusted",
    "runningExecutableMatchesTrusted",
  ];
  const facts = {
    kind: "podman-owner-snapshot-v1",
    ...Object.fromEntries(fields.map((key) => [key, true])),
  };
  const report = { kind: unavailable.kind, source: "verified", facts };
  const command = async () => ({
    exitCode: 0,
    timedOut: false,
    stderr: "",
    stdout: JSON.stringify(report),
  });
  expect(await captureBoundedPodmanOwnerDiagnostic({ command } as never, {}, "before")).toEqual(
    report,
  );
});

it("loads the real collector from an unrelated child working directory", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { captureBoundedPodmanOwnerDiagnostic } =
    await import("../fixtures/podman-owner-diagnostic");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-diagnostic-cwd-"));
  let child: ReturnType<typeof spawnSync> | undefined;
  try {
    const command = async (executable: string, args: string[]) => {
      child = spawnSync(executable, args, {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, NEMOCLAW_GATEWAY_RUNTIME: "docker" },
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      return {
        exitCode: child.status,
        timedOut: false,
        stdout: String(child.stdout),
        stderr: String(child.stderr),
      };
    };
    expect(await captureBoundedPodmanOwnerDiagnostic({ command } as never, {}, "before")).toEqual(
      unavailable,
    );
    // An unavailable report alone could hide a loader failure. Require successful
    // child execution and the collector's exact serialized return as well.
    expect(child?.error).toBeUndefined();
    expect(child?.status).toBe(0);
    expect(child?.stderr).toBe("");
    expect(JSON.parse(String(child?.stdout))).toEqual(unavailable);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
