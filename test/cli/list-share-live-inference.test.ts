// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OPENCLAW_EXPECTED_VERSION,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

function createShareTestEnv(prefix: string): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home);

  const writeStub = (command: string, lines: string[]): void => {
    fs.writeFileSync(path.join(localBin, command), ["#!/usr/bin/env bash", ...lines].join("\n"), {
      mode: 0o755,
    });
  };

  writeStub("mountpoint", ["exit 1"]);
  writeStub("mount", ["exit 0"]);
  writeStub("sshfs", ["echo 'stub sshfs failed' >&2", "exit 1"]);
  writeStub("openshell", [
    'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
    "  echo 'Sandbox: alpha'",
    "  echo 'Phase: Ready'",
    "  exit 0",
    "fi",
    'if [ "$1" = "policy" ] && [ "$2" = "get" ]; then',
    "  exit 0",
    "fi",
    'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
    "  exit 0",
    "fi",
    'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
    "  echo 'Host openshell-alpha'",
    "  echo '  HostName 127.0.0.1'",
    "  exit 0",
    "fi",
    "exit 0",
  ]);

  return {
    HOME: home,
    PATH: `${localBin}:${process.env.PATH || ""}`,
  };
}

describe("list shows live gateway inference", () => {
  it("shows live gateway inference for the default sandbox (#2369)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-live-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          test: {
            name: "test",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi", "npm"],
          },
        },
        defaultSandbox: "test",
      }),
      { mode: 0o600 },
    );
    // Stub openshell: inference get returns a different live provider/model
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron-3-super-120b-a12b'",
        "  echo '  Version: 1'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    // Live gateway values render on the default sandbox's main row.
    expect(r.out).toContain(
      "agent: openclaw  model: nvidia/nemotron-3-super-120b-a12b  provider: nvidia-prod  sandbox GPU  policies: pypi, npm",
    );
    // The stale (stored) row must not appear.
    expect(r.out).not.toContain(
      "agent: openclaw  model: configured-model  provider: configured-provider  sandbox GPU  policies: pypi, npm",
    );
    // Onboarded values appear in an explicit live-gateway drift annotation.
    expect(r.out).toContain(
      "(live OpenShell gateway differs from onboarded: model=configured-model, provider=configured-provider)",
    );
  });

  it("falls back to registry values when openshell inference get fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-fallback-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          test: {
            name: "test",
            model: "llama3.2:1b",
            provider: "ollama-local",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "test",
      }),
      { mode: 0o600 },
    );
    // Stub openshell: inference get fails
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("llama3.2:1b");
    expect(r.out).toContain("ollama-local");
  });

  it("lists registered sandboxes when runtime inference probing is degraded", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-runtime-degraded-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      model: "configured-model",
      provider: "nvidia-prod",
      gpuEnabled: false,
      policies: ["pypi"],
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Error: client error (Connect)' >&2",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Sandboxes:");
    expect(r.out).toContain("alpha *");
    expect(r.out).toContain("model: configured-model");
    expect(r.out).toContain("provider: nvidia-prod");
    expect(fs.readFileSync(markerFile, "utf8")).toContain("inference get");
  });

  // ── Issue #1904: sandbox not upgraded after NemoClaw upgrade ───
  // Original report: user upgrades NemoClaw from v0.0.11→v0.0.15 via
  // curl|bash. Existing sandbox still runs old OpenClaw (2026.3.11)
  // because Docker cached the stale :latest image. upgrade-sandboxes
  // --check should detect the version mismatch and report it.

  it(
    "upgrade-sandboxes --check detects a stale sandbox after NemoClaw upgrade (#1904)",
    testTimeoutOptions(),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-upgrade-sandboxes-"));
      const localBin = path.join(home, "bin");
      const nemoclawDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(nemoclawDir, { recursive: true });

      // Registry with a sandbox that has an old agentVersion (the pre-upgrade state)
      fs.writeFileSync(
        path.join(nemoclawDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "my-agent": {
              name: "my-agent",
              model: "nvidia/nemotron-3-super-120b-a12b",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              agentVersion: "2026.3.11",
            },
          },
          defaultSandbox: "my-agent",
        }),
        { mode: 0o600 },
      );

      // Fake openshell that reports the sandbox as running
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  echo "my-agent   Running   openclaw"',
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "my-agent" ]; then',
          "  echo 'Sandbox: my-agent'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "my-agent" ]; then',
          "  echo 'Host openshell-my-agent'",
          "  echo '  HostName 127.0.0.1'",
          "  exit 0",
          "fi",
          'if [ "$1" = "--version" ]; then',
          '  echo "openshell 0.0.24"',
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

      const r = runWithEnv("upgrade-sandboxes --check 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      // Should report the stale sandbox with version info
      expect(r.out).toContain("my-agent");
      expect(r.out).toContain("2026.3.11");
      expect(r.out).toMatch(/stale|need upgrading/i);
    },
  );

  it(
    "upgrade-sandboxes --check reports all-current when no sandboxes are stale (#1904)",
    testTimeoutOptions(),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-upgrade-current-"));
      const localBin = path.join(home, "bin");
      const nemoclawDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(nemoclawDir, { recursive: true });

      // Registry with a sandbox at the current version — should NOT be stale
      fs.writeFileSync(
        path.join(nemoclawDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "my-agent": {
              name: "my-agent",
              model: "nvidia/nemotron-3-super-120b-a12b",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              agentVersion: "9999.12.31",
            },
          },
          defaultSandbox: "my-agent",
        }),
        { mode: 0o600 },
      );

      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  echo "my-agent   Running   openclaw"',
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "my-agent" ]; then',
          "  echo 'Sandbox: my-agent'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "my-agent" ]; then',
          "  echo 'Host openshell-my-agent'",
          "  echo '  HostName 127.0.0.1'",
          "  exit 0",
          "fi",
          'if [ "$1" = "--version" ]; then',
          '  echo "openshell 0.0.24"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "ssh"),
        ["#!/usr/bin/env bash", "echo 'OpenClaw 9999.12.31 (new)'", "exit 0"].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("upgrade-sandboxes --check 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("up to date");
    },
  );

  // ── Issue #5026: sandbox not upgraded after NemoClaw upgrade with an ──
  // unchanged OpenClaw version. The agent version still matches, but the
  // NemoClaw build that produced the image changed, so the sandbox needs a
  // rebuild. A stale recorded NemoClaw fingerprint must be detected even when
  // the agent version is current.
  it(
    "upgrade-sandboxes --check detects NemoClaw image drift when the agent version is unchanged (#5026)",
    testTimeoutOptions(),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-upgrade-imagedrift-"));
      const localBin = path.join(home, "bin");
      const nemoclawDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(nemoclawDir, { recursive: true });

      // Sandbox at the CURRENT agent version but built by an older NemoClaw
      // (stale fingerprint "0.0.1"). Only the NemoClaw image drifted.
      fs.writeFileSync(
        path.join(nemoclawDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "my-agent": {
              name: "my-agent",
              model: "nvidia/nemotron-3-super-120b-a12b",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              agentVersion: OPENCLAW_EXPECTED_VERSION,
              nemoclawVersion: "0.0.1",
            },
          },
          defaultSandbox: "my-agent",
        }),
        { mode: 0o600 },
      );

      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  echo "my-agent   Running   openclaw"',
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "my-agent" ]; then',
          "  echo 'Host openshell-my-agent'",
          "  echo '  HostName 127.0.0.1'",
          "  exit 0",
          "fi",
          'if [ "$1" = "--version" ]; then',
          '  echo "openshell 0.0.24"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      // Live probe reports the CURRENT agent version, so agent-version is NOT stale.
      fs.writeFileSync(
        path.join(localBin, "ssh"),
        ["#!/usr/bin/env bash", `echo 'OpenClaw ${OPENCLAW_EXPECTED_VERSION}'`, "exit 0"].join(
          "\n",
        ),
        { mode: 0o755 },
      );

      const r = runWithEnv("upgrade-sandboxes --check 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out).not.toContain("All sandboxes are up to date.");
      expect(r.out).toContain("my-agent");
      // Surfaces the NemoClaw image drift with the stale recorded fingerprint.
      expect(r.out).toContain("NemoClaw image v0.0.1");
      expect(r.out).toMatch(/stale|need upgrading/i);
    },
  );

  it(
    "upgrade-sandboxes --check probes running sandboxes before trusting cached metadata (#4429)",
    testTimeoutOptions(),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-upgrade-probe-"));
      const localBin = path.join(home, "bin");
      const nemoclawDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(nemoclawDir, { recursive: true });

      fs.writeFileSync(
        path.join(nemoclawDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "my-agent": {
              name: "my-agent",
              model: "nvidia/nemotron-3-super-120b-a12b",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              agentVersion: "2026.5.18",
            },
          },
          defaultSandbox: "my-agent",
        }),
        { mode: 0o600 },
      );

      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  echo "my-agent   Running   openclaw"',
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "my-agent" ]; then',
          "  echo 'Sandbox: my-agent'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "my-agent" ]; then',
          "  echo 'Host openshell-my-agent'",
          "  echo '  HostName 127.0.0.1'",
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

      const r = runWithEnv("upgrade-sandboxes --check 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("my-agent");
      expect(r.out).toContain("2026.3.11");
      expect(r.out).toMatch(/stale|need upgrading/i);
      expect(r.out).not.toContain("All sandboxes are up to date.");
    },
  );

  it("share with no subcommand prints usage help", () => {
    const env = createShareTestEnv("nemoclaw-cli-share-");

    const r = runWithEnv("alpha share", env);

    expect(r.code).toBe(0);
    expect(r.out).toContain("$ nemoclaw sandbox share <mount|unmount|status> <name>");
    expect(r.out).toContain("mount");
    expect(r.out).toContain("unmount");
    expect(r.out).toContain("status");
  });

  it("share help uses native oclif usage", testTimeoutOptions(15_000), () => {
    const env = createShareTestEnv("nemoclaw-cli-share-help-");

    const parent = runWithEnv("alpha share --help", env);
    expect(parent.code).toBe(0);
    expect(parent.out).toContain("$ nemoclaw sandbox share <mount|unmount|status> <name>");

    for (const [subcommand, usage] of [
      ["mount", "share mount <name> [sandbox-path] [local-mount-point]"],
      ["unmount", "share unmount <name> [local-mount-point]"],
      ["status", "share status <name> [local-mount-point]"],
    ]) {
      const result = runWithEnv(`alpha share ${subcommand} --help`, env);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`$ nemoclaw sandbox ${usage}`);
    }
  });

  it("share is recognized as a valid sandbox action (not 'Unknown action')", () => {
    const env = createShareTestEnv("nemoclaw-cli-share-action-");

    const r = runWithEnv("alpha share mount", env);

    // Will fail because sshfs/sandbox isn't running, but should NOT say "Unknown action"
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("Unknown action");
  });

  it("unknown share subcommands fail before action dispatch", () => {
    const env = createShareTestEnv("nemoclaw-cli-share-unknown-");

    const r = runWithEnv("alpha share bogus 2>&1", env);

    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Unexpected argument:|Command .*not found/);
  });
});
