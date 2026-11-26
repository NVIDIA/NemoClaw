// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

const original = "|/fixture/original-handler %p\n";

describe("managed-image passive crash capture workflow", () => {
  it("removes private crash memory when preparation did not save the core pattern", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = required(workflow.jobs?.["pr-build-and-entrypoint"], "missing PR builder");
    const cleanup = step(builder, "Restore core settings and remove private Hermes crash memory");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-core-cleanup-"));
    const privateMemory = path.join(directory, "nemoclaw-hermes-crash-owned");
    const unrelated = path.join(directory, "unrelated");
    try {
      fs.mkdirSync(privateMemory);
      fs.writeFileSync(path.join(privateMemory, "core"), "private synthetic process memory");
      fs.mkdirSync(unrelated);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
        sudo() { return 91; }
        docker() { test "$*" = 'ps -aq --filter label=io.nvidia.nemoclaw.hermes-crash-capture=1'; }
        ${required(cleanup.run, "missing capture cleanup")}
      `,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: { PATH: process.env.PATH, RUNNER_TEMP: directory },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(privateMemory)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { failure: "none", expectedPattern: original },
    { failure: "package-update", expectedPattern: original },
    { failure: "package-install", expectedPattern: original },
    { failure: "prepare", expectedPattern: original },
    { failure: "restore", expectedPattern: "/tmp/nemoclaw-hermes-crash/core.%p\n" },
    { failure: "read", expectedPattern: original },
    { failure: "read-after-output", expectedPattern: original },
    { failure: "mismatch", expectedPattern: "different\n" },
    { failure: "saved-remove", expectedPattern: original },
    { failure: "list", expectedPattern: original },
    { failure: "remove", expectedPattern: original },
  ])("cleans private memory across the $failure failure case", ({ failure, expectedPattern }) => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = required(workflow.jobs?.["pr-build-and-entrypoint"], "missing PR builder");
    const prepare = step(builder, "Prepare passive Hermes native crash capture");
    const qualification = step(builder, "Qualify Hermes root entrypoint and Switchyard package");
    const cleanup = step(builder, "Restore core settings and remove private Hermes crash memory");
    const packageFailure = failure.startsWith("package-");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-core-cleanup-"));
    const kernel = path.join(directory, "synthetic-core-pattern");
    const saved = path.join(directory, "nemoclaw-hermes-original-core-pattern");
    const privateMemory = path.join(directory, "nemoclaw-hermes-crash-owned");
    const unrelated = path.join(directory, "unrelated");
    const removed = path.join(directory, "container-removal-attempted");
    const output = path.join(directory, "step-output");
    // Execute the workflow shell with only privileged/external boundaries replaced.
    // Real temporary files exercise restoration and deletion; no host kernel
    // setting, package manager or Docker daemon is touched.
    const boundaries = String.raw`
      gdb() { :; }
      command() {
        if test "$*" = '-v gdb' && test -n "$FAIL_PACKAGE"; then return 1; fi
        builtin command "$@"
      }
      sudo() {
        if test "$1" = timeout; then
          test "$2 $3 $4" = '--signal=TERM --kill-after=10s 120s' || return 95
          shift 4
        fi
        if test "$1" = apt-get; then test "$2" != "$FAIL_PACKAGE"; return; fi
        test "$1" = tee && test "$2" = "$FAKE_KERNEL" || return 92
        test "$FAIL_WRITE" != 1 || return 1
        command tee "$FAKE_KERNEL"
        if test "$FAILURE" = mismatch; then printf 'different\n' > "$FAKE_KERNEL"; fi
      }
      cat() {
        test "$*" = "$FAKE_KERNEL" || return 93
        test "$FAILURE" != read || return 1
        command cat "$@"
        test "$FAILURE" != read-after-output
      }
      rm() {
        if test "$FAILURE" = saved-remove && test "$*" = "-f $SAVED"; then return 1; fi
        command rm "$@"
      }
      docker() {
        case "$*" in
          'ps -aq --filter label=io.nvidia.nemoclaw.hermes-crash-capture=1')
            test "$FAIL_LIST" != 1 || return 1
            printf '%s\n' owned-container ;;
          'rm -f owned-container')
            touch "$REMOVAL_ATTEMPT"
            test "$FAIL_REMOVE" != 1 ;;
          *) return 94 ;;
        esac
      }
    `;
    const execute = (script: string, phase: "prepare" | "cleanup") =>
      spawnSync(
        "bash",
        [
          "-c",
          `${boundaries}\n${script.replaceAll("/proc/sys/kernel/core_pattern", '"$FAKE_KERNEL"')}`,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            RUNNER_TEMP: directory,
            GITHUB_OUTPUT: output,
            FAIL_PACKAGE: packageFailure ? failure.slice("package-".length) : "",
            FAKE_KERNEL: kernel,
            SAVED: saved,
            FAILURE: phase === "cleanup" ? failure : "",
            REMOVAL_ATTEMPT: removed,
            FAIL_WRITE: (phase === "prepare" ? failure === "prepare" : failure === "restore")
              ? "1"
              : "0",
            FAIL_LIST: failure === "list" ? "1" : "0",
            FAIL_REMOVE: failure === "remove" ? "1" : "0",
          },
        },
      );
    try {
      fs.writeFileSync(kernel, original);
      fs.writeFileSync(output, "");
      const setup = execute(required(prepare.run, "missing capture setup"), "prepare");
      expect(setup.status, setup.stderr).toBe(failure === "prepare" ? 1 : 0);
      expect(fs.existsSync(saved)).toBe(!packageFailure);
      expect(fs.readFileSync(packageFailure ? kernel : saved, "utf8")).toBe(original);
      expect(fs.readFileSync(output, "utf8")).toBe(
        packageFailure || failure === "prepare" ? "" : "enabled=true\n",
      );
      expect(prepare.id).toBe("hermes-crash-capture");
      expect(qualification.env?.NEMOCLAW_HERMES_CRASH_CAPTURE).toBe(
        "${{ matrix.arch == 'amd64' && steps.hermes-crash-capture.outputs.enabled == 'true' && '1' || '0' }}",
      );
      expect(prepare).not.toHaveProperty("continue-on-error");
      expect(qualification).not.toHaveProperty("continue-on-error");
      expect(cleanup).not.toHaveProperty("continue-on-error");
      expect(cleanup.if).toBe("always() && matrix.agent == 'hermes' && matrix.arch == 'amd64'");
      fs.mkdirSync(privateMemory);
      fs.writeFileSync(path.join(privateMemory, "core"), "private synthetic process memory");
      fs.mkdirSync(unrelated);
      const result = execute(required(cleanup.run, "missing capture cleanup"), "cleanup");
      expect(result.status, result.stderr).toBe(
        packageFailure || ["none", "prepare"].includes(failure) ? 0 : 1,
      );
      expect(fs.existsSync(privateMemory)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
      expect(fs.existsSync(removed)).toBe(failure !== "list");
      expect(fs.existsSync(saved)).toBe(
        ["restore", "read", "read-after-output", "mismatch", "saved-remove"].includes(failure),
      );
      expect(fs.readFileSync(kernel, "utf8")).toBe(expectedPattern);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["update", "install"])(
    "returns without enabling capture when apt %s hangs",
    (hangingPhase) => {
      const workflow = readWorkflow("managed-images.yaml");
      const builder = required(workflow.jobs?.["pr-build-and-entrypoint"], "missing PR builder");
      const prepare = step(builder, "Prepare passive Hermes native crash capture");
      const qualification = step(builder, "Qualify Hermes root entrypoint and Switchyard package");
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-core-package-hang-"));
      const bin = path.join(directory, "bin");
      const trace = path.join(directory, "package-trace");
      const output = path.join(directory, "step-output");
      const saved = path.join(directory, "nemoclaw-hermes-original-core-pattern");
      try {
        fs.mkdirSync(bin);
        fs.writeFileSync(output, "");
        // Replace privileged package commands with a real never-settling process.
        // The timeout boundary checks production arguments, then shortens only the
        // fixture's wait so the shell fallback is exercised without package access.
        fs.writeFileSync(
          path.join(bin, "apt-get"),
          `#!${process.execPath}
const fs = require('node:fs');
const phase = process.argv[2];
fs.appendFileSync(process.env.PACKAGE_TRACE, phase + '\\n');
if (phase === process.env.HANG_PHASE) {
  fs.writeFileSync(process.env.HANG_PID, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`,
          { mode: 0o700 },
        );
        fs.writeFileSync(
          path.join(bin, "timeout"),
          `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.slice(0, 4).join(' ') !== '--signal=TERM --kill-after=10s 120s apt-get') process.exit(95);
const result = spawnSync(args[3], args.slice(4), {
  env: process.env, timeout: 300, killSignal: 'SIGKILL', stdio: 'ignore',
});
if (result.error?.code === 'ETIMEDOUT' && result.signal === 'SIGKILL') {
  fs.appendFileSync(process.env.PACKAGE_TRACE, 'killed-' + args[4] + '\\n');
  process.exit(124);
}
process.exit(result.status ?? 96);
`,
          { mode: 0o700 },
        );
        const pidFile = path.join(directory, "hang.pid");
        const result = spawnSync(
          "bash",
          [
            "-c",
            `
sudo() { test "$1" = timeout || return 92; "$@"; }
cp() { return 93; }
command() { if test "$*" = '-v gdb'; then return 1; fi; builtin command "$@"; }
${required(prepare.run, "missing capture setup")}
`,
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              RUNNER_TEMP: directory,
              GITHUB_OUTPUT: output,
              PACKAGE_TRACE: trace,
              HANG_PHASE: hangingPhase,
              HANG_PID: pidFile,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "::warning::Debugger installation failed; Hermes qualification will run without crash capture.",
        );
        expect(fs.readFileSync(trace, "utf8")).toBe(
          hangingPhase === "update"
            ? "update\nkilled-update\n"
            : "update\ninstall\nkilled-install\n",
        );
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        let remainingProcessError: string | undefined;
        try {
          process.kill(pid, 0);
        } catch (error) {
          remainingProcessError = (error as NodeJS.ErrnoException).code;
        }
        expect(remainingProcessError).toBe("ESRCH");
        expect(fs.readFileSync(output, "utf8")).toBe("");
        expect(fs.existsSync(saved)).toBe(false);
        expect(prepare).toHaveProperty("timeout-minutes", 5);
        expect(qualification).toHaveProperty("timeout-minutes", 30);
        expect(qualification.if).toBe("matrix.agent == 'hermes'");
        expect(qualification.run).toContain("test/e2e/live/hermes-root-entrypoint-smoke.test.ts");
        expect(prepare).not.toHaveProperty("continue-on-error");
        expect(qualification).not.toHaveProperty("continue-on-error");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
