// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function runWithEnv(args: string, env: Record<string, string> = {}, timeout = 25_000) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout,
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-brev-home-")),
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

function writeStub(binDir: string, name: string, lines: string[]) {
  fs.writeFileSync(path.join(binDir, name), lines.join("\n"), { mode: 0o755 });
}

function readBrevCalls(markerFile: string) {
  return fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
}

function setupDeployStubs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-deploy-brev-"));
  const localBin = path.join(home, "bin");
  const markerFile = path.join(home, "brev-args");

  fs.mkdirSync(localBin, { recursive: true });

  writeStub(localBin, "brev", [
    "#!/usr/bin/env bash",
    `marker_file=${JSON.stringify(markerFile)}`,
    'printf \'%s\\n\' "$*" >> "$marker_file"',
    'if [ "$1" = "ls" ]; then',
    "  exit 0",
    "fi",
    "exit 0",
  ]);
  writeStub(localBin, "ssh", ["#!/usr/bin/env bash", "exit 0"]);
  writeStub(localBin, "rsync", ["#!/usr/bin/env bash", "exit 0"]);
  writeStub(localBin, "scp", ["#!/usr/bin/env bash", "exit 0"]);

  return {
    home,
    localBin,
    markerFile,
  };
}

describe("deploy brev compatibility", () => {
  it("uses --type and --gpu-name for legacy combined NEMOCLAW_GPU", () => {
    const { home, localBin, markerFile } = setupDeployStubs();

    const result = runWithEnv("deploy pr-1377-legacy", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NVIDIA_API_KEY: "nvapi-test",
      NEMOCLAW_GPU: "a2-highgpu-1g:nvidia-tesla-a100:1",
    });

    expect(result.code).toBe(0);
    const calls = readBrevCalls(markerFile);
    expect(calls).toContain("ls");
    expect(calls).toContain("create pr-1377-legacy --type a2-highgpu-1g --gpu-name A100");
    expect(calls.join("\n")).not.toContain("--gpu ");
  });

  it("prefers explicit Brev override env vars over the legacy combined value", () => {
    const { home, localBin, markerFile } = setupDeployStubs();

    const result = runWithEnv("deploy pr-1377-overrides", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NVIDIA_API_KEY: "nvapi-test",
      NEMOCLAW_GPU: "a2-highgpu-1g:nvidia-tesla-a100:1",
      NEMOCLAW_BREV_TYPE: "a3-highgpu-1g",
      NEMOCLAW_BREV_GPU_NAME: "h100",
    });

    expect(result.code).toBe(0);
    const calls = readBrevCalls(markerFile);
    expect(calls).toContain("create pr-1377-overrides --type a3-highgpu-1g --gpu-name H100");
    expect(calls.join("\n")).not.toContain("--gpu ");
  });

  it("falls back to default Brev type and GPU name when no env vars are set", () => {
    const { home, localBin, markerFile } = setupDeployStubs();

    const result = runWithEnv("deploy pr-1377-defaults", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NVIDIA_API_KEY: "nvapi-test",
    });

    expect(result.code).toBe(0);
    const calls = readBrevCalls(markerFile);
    expect(calls).toContain("create pr-1377-defaults --type a2-highgpu-1g --gpu-name A100");
    expect(calls.join("\n")).not.toContain("--gpu ");
  });
});
