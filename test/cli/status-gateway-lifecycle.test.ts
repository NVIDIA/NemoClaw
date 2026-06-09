// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OPENCLAW_EXPECTED_VERSION,
  execTimeout,
  runWithEnv,
  testTimeout,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

describe("CLI dispatch", () => {
  it(
    "keeps registry entries when status hits a gateway-level transport error",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-error-"));
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
          "  echo 'Error: transport error: handshake verification failed' >&2",
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("gateway identity drift after restart")).toBeTruthy();
      const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
      expect(saved.sandboxes.alpha).toBeTruthy();
    },
    testTimeout(10_000),
  );

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
      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "100",
        },
        10000,
      );

      expect(Date.now() - started).toBeLessThan(7000);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Model:    test-model");
      expect(r.out).toContain("Live sandbox status probe timed out");
    },
    testTimeout(10_000),
  );

  it("recovers status after gateway runtime is reattached", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-status-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const stateFile = path.join(home, "sandbox-get-count");
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
        `state_file=${JSON.stringify(stateFile)}`,
        'count=$(cat "$state_file" 2>/dev/null || echo 0)',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  count=$((count + 1))",
        '  echo "$count" > "$state_file"',
        '  if [ "$count" -eq 1 ]; then',
        "    echo 'Error: transport error: Connection refused' >&2",
        "    exit 1",
        "  fi",
        "  echo 'Sandbox: alpha'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeTruthy();
    expect(r.out.includes("Sandbox: alpha")).toBeTruthy();
  });

  it("shows a clear local inference warning when Ollama is down", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-local-inference-down-"));
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
            model: "llama3.2:1b",
            provider: "ollama-local",
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
        "  echo 'Sandbox: alpha'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  exit 1",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: ollama-local'",
        "  echo '  Model: llama3.2:1b'",
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
        'url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift 2 ;;',
        "    -w|--connect-timeout|--max-time) shift 2 ;;",
        "    -s|-S|-sS|-f) shift ;;",
        '    http://*|https://*) url="$1"; shift ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ -n "$out" ]; then : > "$out"; fi',
        'if echo "$url" | grep -q "11434/api/tags"; then',
        '  printf "000"',
        "  exit 7",
        "fi",
        'printf "000"',
        "exit 7",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    // #3265: backend label is qualified `Inference (ollama backend):` so the
    // upcoming auth-proxy subprobe line renders in parallel.
    expect(r.out).toContain("Inference (ollama backend):");
    expect(r.out).toContain("unreachable");
    expect(r.out).toContain("Start Ollama and retry");
    expect(r.out).toContain("http://127.0.0.1:11434/api/tags");
  });

  it(
    "status reports fresh shields state as not configured instead of down",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-status-shields-default-"),
      );
      const localBin = path.join(home, "bin");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: sandbox not found' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  echo '  Status: Connected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("alpha status 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(1);
      expect(r.out).toContain("Permissions: not configured (default mutable state)");
      expect(r.out).not.toContain("Permissions: shields down");
    },
  );

  it("prints healthy inference only after the sandbox and gateway are verified", () => {
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
        "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "  echo 'RUNNING'",
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

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Sandbox: alpha");
    expect(r.out).toContain("Model:    live-model");
    expect(r.out).toContain("Provider: nvidia-prod");
    expect(r.out).toContain("Inference:");
    expect(r.out).toContain("healthy");
    expect(r.out).not.toContain("not verified");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    const sandboxGetIdx = calls.indexOf("sandbox get alpha");
    const inferenceGetIdx = calls.indexOf("inference get");
    expect(sandboxGetIdx).toBeGreaterThanOrEqual(0);
    expect(inferenceGetIdx).toBeGreaterThan(sandboxGetIdx);
  });

  it("status reports the live sandbox agent version instead of cached host metadata", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-agent-drift-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      model: "configured-model",
      provider: "nvidia-prod",
      agentVersion: "2026.5.18",
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
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
        "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "  echo 'RUNNING'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      ["#!/usr/bin/env bash", "echo 'OpenClaw 2026.3.11 (old)'", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Agent:    OpenClaw v2026.3.11");
    expect(r.out).toContain("Update:");
    expect(r.out).toContain(`v${OPENCLAW_EXPECTED_VERSION} available`);
    expect(r.out).toContain("Run `nemoclaw alpha rebuild` to upgrade");
    expect(r.out).not.toContain("Agent:    OpenClaw v2026.5.18");
  });

  it(
    "does not treat a different connected gateway as a healthy nemoclaw gateway",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-mixed-gateway-"));
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
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Connected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeFalsy();
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("verify the active gateway")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "matches ANSI-decorated gateway transport errors when printing lifecycle hints",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-transport-hint-"));
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
          "  printf '\\033[31mError: trans\\033[0mport error: Connec\\033[33mtion refused\\033[0m\\n' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("current gateway/runtime is not reachable")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "matches ANSI-decorated gateway auth errors when printing lifecycle hints",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-auth-hint-"));
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
          "  printf '\\033[31mMissing gateway auth\\033[0m token\\n' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(
        r.out.includes("Verify the active gateway and retry after re-establishing the runtime."),
      ).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it("explains unrecoverable gateway trust rotation after restart", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-identity-drift-"));
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
        "  echo 'Error: transport error: handshake verification failed' >&2",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const statusResult = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(),
    );
    expect(statusResult.code).toBe(1);
    expect(statusResult.out.includes("gateway trust material rotated after restart")).toBeTruthy();
    expect(statusResult.out.includes("cannot be reattached safely")).toBeTruthy();

    const connectResult = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(connectResult.code).toBe(1);
    // After the auto-recovery attempt (clear stale host keys + retry), the
    // fake openshell still returns the handshake error, so recovery fails.
    expect(connectResult.out.includes("Could not reconnect")).toBeTruthy();
    expect(connectResult.out.includes("Recreate this sandbox")).toBeTruthy();
  });

  it(
    "explains when gateway metadata exists but the restarted API is still refusing connections",
    { timeout: 30000 },
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-unreachable-"));
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
          `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  echo '  Server: https://127.0.0.1:8080'",
          "  echo 'Error: client error (Connect)' >&2",
          "  echo 'Connection refused (os error 111)' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
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

      const statusResult = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );
      expect(statusResult.code).toBe(1);
      expect(statusResult.out).not.toContain("Inference: healthy");
      expect(statusResult.out).toContain(
        "Inference: not verified (gateway/sandbox state not verified)",
      );
      expect(fs.readFileSync(markerFile, "utf8")).not.toContain("inference get");
      expect(
        statusResult.out.includes("gateway is still refusing connections after restart"),
      ).toBeTruthy();
      expect(
        statusResult.out.includes("Retry `openshell gateway start --name nemoclaw`"),
      ).toBeTruthy();

      const connectResult = runWithEnv("alpha connect", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(connectResult.code).toBe(1);
      expect(
        connectResult.out.includes("gateway is still refusing connections after restart"),
      ).toBeTruthy();
      expect(connectResult.out.includes("If the gateway never becomes healthy")).toBeTruthy();
    },
  );

  it(
    "explains when the named gateway is no longer configured after restart or rebuild",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-missing-"));
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
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Gateway Status'",
          "  echo",
          "  echo '  Status: No gateway configured.'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 1",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const statusResult = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );
      expect(statusResult.code).toBe(1);
      expect(
        statusResult.out.includes("gateway is no longer configured after restart/rebuild"),
      ).toBeTruthy();
      expect(statusResult.out.includes("Start the gateway again")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it("preserves an orphan registry entry on passive status when the named gateway is healthy", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-orphan-"));
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
        "  echo 'Error: status: NotFound, message: \"sandbox not found\"' >&2",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  printf 'Gateway: nemoclaw\\n'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const statusResult = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(),
    );

    expect(statusResult.code).toBe(1);
    expect(statusResult.out).not.toContain("Inference: healthy");
    expect(statusResult.out).toContain(
      "registered locally, but is not present in the live OpenShell gateway",
    );
    expect(statusResult.out).toContain("No local registry entry was removed");
    expect(statusResult.out).not.toContain("Removed stale local registry entry");

    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeDefined();
    expect(saved.defaultSandbox).toBe("alpha");
  });
});
