// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../fixtures/clients/command.ts";
import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";

function withFakeProcRoot<T>(run: (procRoot: string) => T): T {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-process-token-probe-"));
  try {
    return run(procRoot);
  } finally {
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
}

function writeCmdline(procRoot: string, pid: string, args: string[]): void {
  const procDir = path.join(procRoot, pid);
  fs.mkdirSync(procDir);
  fs.writeFileSync(path.join(procDir, "cmdline"), Buffer.from(`${args.join("\0")}\0`));
}

function runProbe(script: string): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

function expectProbeResult(result: SpawnSyncReturns<string>, expected: string): void {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
  expect(result.stderr).toBe("");
}

function probeDiagnosticsContainToken(
  script: string,
  result: SpawnSyncReturns<string>,
  token: string,
): boolean {
  return [script, result.stdout, result.stderr, result.error?.message ?? ""].some((value) =>
    value.includes(token),
  );
}

describe("process token probe", () => {
  it("rejects token values that cannot be scanned literally", () => {
    expect(() => buildProcessTokenProbe("")).toThrow("requires a nonempty token");
    expect(() => buildProcessTokenProbe("contains\0nul")).toThrow("does not accept NUL bytes");
  });

  it("ignores its encoded command and excludes the scanner shell PID", () =>
    withFakeProcRoot((procRoot) => {
      const token = `scanner-self-secret-${process.pid}`;
      const encodedToken = Buffer.from(token, "utf8").toString("base64");
      const scanner = buildProcessTokenProbe(token, procRoot);
      writeCmdline(procRoot, "101", ["sh", "-c", scanner]);

      const selfCmdline = `${shellQuote(procRoot)}/$$/cmdline`;
      const script = `mkdir -p ${shellQuote(procRoot)}/$$
printf 'sh\\000-c\\000' > ${selfCmdline}
printf '%s' ${shellQuote(encodedToken)} | base64 -d >> ${selfCmdline}
printf '\\000' >> ${selfCmdline}
${scanner}`;
      const result = runProbe(script);

      expect(scanner).toContain(encodedToken);
      expect(scanner).toContain('case "$nemoclaw_process_probe_cmdline" in');
      expect(scanner).not.toContain("grep");
      expectProbeResult(result, "ABSENT");
      expect(probeDiagnosticsContainToken(scanner, result, token)).toBe(false);
      fs.rmSync(path.join(procRoot, String(result.pid)), { recursive: true, force: true });

      const traced = spawnSync("sh", ["-x", "-c", scanner], { encoding: "utf8" });
      expect(traced.status, traced.stderr).toBe(0);
      expect(traced.stdout.trim()).toBe("ABSENT");
      expect(probeDiagnosticsContainToken(scanner, traced, token)).toBe(false);
    }));

  it("reports the PID whose NUL-separated command line contains the literal token", () =>
    withFakeProcRoot((procRoot) => {
      const token = `literal-process-secret-${process.pid}\n`;
      const scanner = buildProcessTokenProbe(token, procRoot);
      writeCmdline(procRoot, "1111", ["node", "worker.js", `--token=${token.slice(0, -1)}`, ""]);
      writeCmdline(procRoot, "4242", ["node", "worker.js", `--token=${token}`]);

      const result = runProbe(scanner);

      expectProbeResult(result, "FOUND pid=4242");
      expect(probeDiagnosticsContainToken(scanner, result, token)).toBe(false);

      const noglob = spawnSync("sh", ["-f", "-c", scanner], { encoding: "utf8" });
      expectProbeResult(noglob, "FOUND pid=4242");
    }));

  it("ignores missing and disappearing proc entries", () =>
    withFakeProcRoot((procRoot) => {
      fs.mkdirSync(path.join(procRoot, "1001"));
      fs.mkdirSync(path.join(procRoot, "1002"));
      fs.symlinkSync(
        path.join(procRoot, "already-disappeared"),
        path.join(procRoot, "1002", "cmdline"),
      );

      const result = runProbe(buildProcessTokenProbe("missing-entry-secret", procRoot));

      expectProbeResult(result, "ABSENT");
    }));

  it("tolerates inspect-time disappearance but fails closed on transform errors", () =>
    withFakeProcRoot((procRoot) => {
      const token = `disappearing-process-secret-${process.pid}`;
      const scanner = buildProcessTokenProbe(token, procRoot);
      writeCmdline(procRoot, "2002", ["worker", token]);
      const cmdlinePath = path.join(procRoot, "2002", "cmdline");
      const shimDir = path.join(procRoot, "bin");
      const trShim = path.join(shimDir, "tr");
      fs.mkdirSync(shimDir);
      fs.writeFileSync(
        trShim,
        `#!/bin/sh
case "$NEMOCLAW_TEST_TR_MODE" in
  disappear) rm -f "$NEMOCLAW_TEST_TR_PATH" ;;
esac
exit 1
`,
        { mode: 0o755 },
      );
      const env = {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        NEMOCLAW_TEST_TR_PATH: cmdlinePath,
      };

      const disappeared = spawnSync("sh", ["-c", scanner], {
        encoding: "utf8",
        env: { ...env, NEMOCLAW_TEST_TR_MODE: "disappear" },
      });
      expectProbeResult(disappeared, "ABSENT");

      fs.writeFileSync(cmdlinePath, Buffer.from(`worker\0${token}\0`));
      const transformFailure = spawnSync("sh", ["-c", scanner], {
        encoding: "utf8",
        env: { ...env, NEMOCLAW_TEST_TR_MODE: "fail" },
      });
      expect(transformFailure.status).toBe(2);
      expect(transformFailure.stdout).toBe("");
      expect(transformFailure.stderr).toBe("");
    }));

  it("matches shell metacharacters literally without command injection", () =>
    withFakeProcRoot((procRoot) => {
      const marker = path.join(procRoot, "injected");
      const token = `meta-*?[ab];$(touch ${marker})`;
      const decoy = `meta-XYa;$(touch ${marker})`;
      const scanner = buildProcessTokenProbe(token, procRoot);
      writeCmdline(procRoot, "1111", ["worker", decoy]);
      writeCmdline(procRoot, "4242", ["worker", token]);

      const result = runProbe(scanner);

      expectProbeResult(result, "FOUND pid=4242");
      expect(fs.existsSync(marker)).toBe(false);
      expect(probeDiagnosticsContainToken(scanner, result, token)).toBe(false);
    }));
});
