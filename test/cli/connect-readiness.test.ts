// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  execTimeout,
  runWithEnv,
  testTimeout,
  testTimeoutOptions,
  writeHealthyDockerStub,
} from "./helpers";

describe("CLI connect readiness", () => {
  it("waits for sandbox readiness before connecting", testTimeoutOptions(15_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-wait-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    const stateFile = path.join(home, "sandbox-list-count");
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
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Pending'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  count=$(cat "$state_file" 2>/dev/null || echo 0)',
        "  count=$((count + 1))",
        '  echo "$count" > "$state_file"',
        '  if [ "$count" -eq 1 ]; then',
        "    echo 'alpha   ContainerCreating   10s ago'",
        "  else",
        "    echo 'alpha   Ready   20s ago'",
        "  fi",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "sleep"), ["#!/usr/bin/env bash", "exit 0"].join("\n"), {
      mode: 0o755,
    });
    // Healthy Docker so the connect readiness wait is not short-circuited by
    // the #4428 docker-down fast-fail.
    writeHealthyDockerStub(localBin);

    const r = runWithEnv(
      "alpha connect",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(30_000),
    );

    expect(r.code).toBe(0);
    expect(r.out.includes("Waiting for sandbox 'alpha' to be ready")).toBeTruthy();
    expect(r.out.includes("Sandbox is ready. Connecting")).toBeTruthy();
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.filter((call) => call === "sandbox list").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("sandbox connect alpha");
  });

  it(
    "fails fast with gateway recovery guidance when connect readiness sees a disconnected gateway",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-gateway-down-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "openshell-calls");
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
      writeHealthyDockerStub(localBin);
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `marker_file=${JSON.stringify(markerFile)}`,
          'printf \'%s\\n\' "$*" >> "$marker_file"',
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo",
          "  echo '  Id: abc'",
          "  echo '  Name: alpha'",
          "  echo '  Namespace: openshell'",
          "  echo '  Phase: Pending'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          "  echo 'alpha   unknown   103s ago'",
          "  exit 0",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
          "  echo 'should-not-connect' >> \"$marker_file\"",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha connect",
        {
          HOME: home,
          NEMOCLAW_CONNECT_TIMEOUT: "1",
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(10_000),
      );

      expect(r.code).toBe(1);
      expect(r.out).toContain("OpenShell gateway is not running or unreachable");
      expect(r.out).toContain("nemoclaw onboard");
      expect(r.out).not.toContain("Timed out after 1s");
      const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(calls).toContain("status");
      expect(calls).not.toContain("should-not-connect");
    },
    testTimeout(15_000),
  );

  it("prints recovery guidance when readiness polling hits a terminal sandbox state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-failed-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
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
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Failed'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'alpha   Failed   1m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  echo 'should-not-connect' >> \"$marker_file\"",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'alpha' is in 'Failed' state")).toBeTruthy();
    expect(r.out.includes("nemoclaw alpha logs --follow")).toBeTruthy();
    expect(r.out.includes("nemoclaw alpha status")).toBeTruthy();
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox list");
    expect(calls).not.toContain("should-not-connect");
  });
});
