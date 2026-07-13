// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { execTimeout, runWithEnv, testTimeout, writeSandboxRegistry } from "./helpers";

describe("CLI status gateway lifecycle process contracts", () => {
  it(
    "keeps status bounded when a live sandbox probe leaves child pipes open",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-timeout-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          `  ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" &`,
          "  wait",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const started = Date.now();
      const result = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "100",
        },
        execTimeout(20_000),
      );

      expect(Date.now() - started).toBeLessThan(execTimeout(12_000));
      expect(result.code).toBe(1);
      expect(result.out).toContain("Model:    test-model");
      expect(result.out).toContain("Live sandbox status probe timed out");
    },
    testTimeout(20_000),
  );

  it("prints the recorded route and healthy inference after verification (#6315)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-healthy-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      model: "configured-model",
      provider: "nvidia-prod",
      gpuEnabled: true,
      policies: ["pypi"],
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: live-model'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  case "$*" in',
        "    *inference.local/v1/models*) echo 'OK 200' ;;",
        "    *) echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'; echo 'RUNNING' ;;",
        "  esac",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "curl"),
      [
        "#!/usr/bin/env bash",
        'out=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift 2 ;;',
        "    -w|--connect-timeout|--max-time) shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ -n "$out" ]; then printf "{}" > "$out"; fi',
        'printf "200"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Sandbox: alpha");
    expect(result.out).toContain("Model:    configured-model");
    expect(result.out).toContain("Provider: nvidia-prod");
    expect(result.out).toContain(
      "gateway inference route (nvidia-prod/live-model) differs from the recorded route for this sandbox (nvidia-prod/configured-model)",
    );
    expect(result.out).toContain("Inference:");
    expect(result.out).toContain("healthy");
    expect(result.out).not.toContain("not verified");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    const sandboxGetIndex = calls.indexOf("sandbox get alpha");
    const inferenceGetIndex = calls.indexOf("inference get -g nemoclaw");
    expect(sandboxGetIndex).toBeGreaterThanOrEqual(0);
    expect(inferenceGetIndex).toBeGreaterThan(sandboxGetIndex);
  });
});
