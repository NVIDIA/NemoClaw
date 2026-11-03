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
  it.each([
    { failure: "none", expectedPattern: original },
    { failure: "prepare", expectedPattern: original },
    { failure: "restore", expectedPattern: "/tmp/nemoclaw-hermes-crash/core.%p\n" },
    { failure: "list", expectedPattern: original },
    { failure: "remove", expectedPattern: original },
  ])("cleans private memory across the $failure failure case", ({ failure, expectedPattern }) => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = required(workflow.jobs?.["pr-build-and-entrypoint"], "missing PR builder");
    const prepare = step(builder, "Prepare passive Hermes native crash capture");
    const cleanup = step(builder, "Restore core settings and remove private Hermes crash memory");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-core-cleanup-"));
    const kernel = path.join(directory, "synthetic-core-pattern");
    const saved = path.join(directory, "nemoclaw-hermes-original-core-pattern");
    const privateMemory = path.join(directory, "nemoclaw-hermes-crash-owned");
    const unrelated = path.join(directory, "unrelated");
    const removed = path.join(directory, "container-removal-attempted");
    // Execute the workflow shell with only privileged/external boundaries replaced.
    // Real temporary files exercise restoration and deletion; no host kernel
    // setting, package manager or Docker daemon is touched.
    const boundaries = String.raw`
      gdb() { :; }
      cp() {
        test "$1" = /proc/sys/kernel/core_pattern || return 91
        command cp "$FAKE_KERNEL" "$2"
      }
      sudo() {
        test "$*" = 'tee /proc/sys/kernel/core_pattern' || return 92
        test "$FAIL_WRITE" != 1 || return 1
        command tee "$FAKE_KERNEL"
      }
      cmp() {
        test "$1" = -s && test "$3" = /proc/sys/kernel/core_pattern || return 93
        command cmp -s "$2" "$FAKE_KERNEL"
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
      spawnSync("bash", ["-c", `${boundaries}\n${script}`], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: directory,
          FAKE_KERNEL: kernel,
          REMOVAL_ATTEMPT: removed,
          FAIL_WRITE: (phase === "prepare" ? failure === "prepare" : failure === "restore")
            ? "1"
            : "0",
          FAIL_LIST: failure === "list" ? "1" : "0",
          FAIL_REMOVE: failure === "remove" ? "1" : "0",
        },
      });
    try {
      fs.writeFileSync(kernel, original);
      const setup = execute(required(prepare.run, "missing capture setup"), "prepare");
      expect(setup.status, setup.stderr).toBe(failure === "prepare" ? 1 : 0);
      expect(fs.readFileSync(saved, "utf8")).toBe(original);
      fs.mkdirSync(privateMemory);
      fs.writeFileSync(path.join(privateMemory, "core"), "private synthetic process memory");
      fs.mkdirSync(unrelated);
      const result = execute(required(cleanup.run, "missing capture cleanup"), "cleanup");
      expect(result.status, result.stderr).toBe(
        ["restore", "list", "remove"].includes(failure) ? 1 : 0,
      );
      expect(fs.existsSync(privateMemory)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
      expect(fs.existsSync(removed)).toBe(failure !== "list");
      expect(fs.existsSync(saved)).toBe(failure === "restore");
      expect(fs.readFileSync(kernel, "utf8")).toBe(expectedPattern);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
