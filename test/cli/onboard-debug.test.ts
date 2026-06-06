// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PARSER_EXIT_CODE,
  createDebugCommandTestEnv,
  run,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

describe("CLI dispatch", () => {
  it(
    "start does not prompt for NVIDIA_API_KEY before launching local services",
    testTimeoutOptions(35_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-start-no-key-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "start-args");
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
        path.join(localBin, "bash"),
        [
          "#!/bin/sh",
          `marker_file=${JSON.stringify(markerFile)}`,
          'printf \'%s\\n\' "$@" > "$marker_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "start",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NVIDIA_API_KEY: "",
          TELEGRAM_BOT_TOKEN: "",
        },
        30000,
      );

      expect(r.code).toBe(0);
      expect(r.out).not.toContain("NVIDIA API Key required");
      // Services module now runs in-process (no bash shelling)
      expect(r.out).toContain("NemoClaw Services");
    },
  );

  it("onboard --help exits 0 and shows usage", () => {
    const r = run("onboard --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    expect(r.out).toContain("nemoclaw onboard");
    expect(r.out).toContain("--from <Dockerfile>");
    expect(r.out).toContain("--yes");
    expect(r.out).toContain("--sandbox-gpu-device=<value>");
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("accepts onboard --resume in CLI parsing", () => {
    const r = run("onboard --resume --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("accepts the third-party software flag in onboard CLI parsing", () => {
    const r = run("onboard --yes-i-accept-third-party-software --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("accepts install automation --yes in onboard CLI parsing", () => {
    const r = run("onboard --resume --non-interactive --yes-i-accept-third-party-software --yes");
    expect(r.code).toBe(1);
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
    expect(r.out).not.toContain("Nonexistent flag: --yes");
  });

  it("passes onboard sandbox GPU flags to legacy validation", () => {
    const r = run(
      "onboard --sandbox-gpu --no-sandbox-gpu --non-interactive --yes-i-accept-third-party-software --yes",
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("--sandbox-gpu and --no-sandbox-gpu are mutually exclusive");
    expect(r.out).not.toContain("Nonexistent flag: --sandbox-gpu");
    expect(r.out).not.toContain("Nonexistent flag: --no-sandbox-gpu");
  });

  it("passes onboard sandbox GPU device flags to legacy validation", () => {
    const r = run(
      "onboard --sandbox-gpu-device nvidia.com/gpu=0 --no-sandbox-gpu --non-interactive --yes-i-accept-third-party-software --yes",
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("--sandbox-gpu-device cannot be used with --no-sandbox-gpu");
    expect(r.out).not.toContain("Nonexistent flag: --sandbox-gpu-device");
  });

  it("setup --help exits 0 and shows onboard usage", () => {
    const r = run("setup --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("setup` is deprecated")).toBeTruthy();
    expect(r.out.includes("Usage: nemoclaw onboard")).toBeTruthy();
    expect(r.out.includes("Unknown onboard option")).toBeFalsy();
  });

  it("setup forwards unknown options into onboard parsing", () => {
    const r = run("setup --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("setup forwards --resume into onboard parsing", () => {
    const r = run("setup --resume --non-interactive --yes-i-accept-third-party-software --yes");
    expect(r.code).toBe(1);
    expect(r.out.includes("deprecated")).toBeTruthy();
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
  });

  it("resume rejection clarifies --resume semantics and points to onboard (#2281)", () => {
    const r = run("onboard --resume --non-interactive --yes-i-accept-third-party-software --yes");
    expect(r.code).toBe(1);
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
    expect(r.out.includes("--resume only continues an interrupted onboarding run")).toBeTruthy();
    expect(
      r.out.includes("To change configuration on an existing sandbox, rebuild it"),
    ).toBeTruthy();
    expect(r.out.includes("nemoclaw onboard")).toBeTruthy();
  });

  it("#2753: refuses non-interactive --resume when sandbox step never completed and no name is provided", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-resume-no-name-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    // Fake openshell so preflight passes and we reach the resume sandbox-name
    // init where the new guard lives.
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--version" ]; then echo "openshell 0.0.37"; exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    // Simulates a pre-fix on-disk session that recorded only provider/model
    // (with #2753's onboard fix, sandboxName is no longer written here either).
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "in_progress",
          mode: "interactive",
          startedAt: "2026-05-03T00:00:00.000Z",
          updatedAt: "2026-05-03T00:00:00.000Z",
          lastStepStarted: "inference",
          lastCompletedStep: "inference",
          failure: null,
          sandboxName: null,
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const r = runWithEnv(
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_SANDBOX_NAME: "",
      },
    );

    expect(r.code).toBe(1);
    expect(r.out.includes("Cannot resume non-interactive onboard")).toBeTruthy();
    expect(r.out.includes("--name <sandbox>")).toBeTruthy();
  });

  it("#2753: whitespace-only NEMOCLAW_SANDBOX_NAME does not satisfy the resume guard", () => {
    // The env-var ingest pipeline trims and rejects whitespace-only values
    // before populating requestedSandboxName, so the guard sees no recovered
    // name and fires correctly.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-resume-ws-name-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--version" ]; then echo "openshell 0.0.37"; exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "in_progress",
          mode: "interactive",
          startedAt: "2026-05-03T00:00:00.000Z",
          updatedAt: "2026-05-03T00:00:00.000Z",
          lastStepStarted: "inference",
          lastCompletedStep: "inference",
          failure: null,
          sandboxName: null,
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const r = runWithEnv(
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_SANDBOX_NAME: "   ",
      },
    );

    expect(r.code).toBe(1);
    expect(r.out.includes("Cannot resume non-interactive onboard")).toBeTruthy();
  });

  it("setup-spark --help exits 0 and shows onboard usage", () => {
    const r = run("setup-spark --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("setup-spark` is deprecated")).toBeTruthy();
    expect(r.out.includes("Use `nemoclaw onboard` instead")).toBeTruthy();
    expect(r.out.includes("Usage: nemoclaw onboard")).toBeTruthy();
    expect(r.out.includes("Unknown onboard option")).toBeFalsy();
  });

  it("setup-spark is a deprecated compatibility alias for onboard", () => {
    const r = run(
      "setup-spark --resume --non-interactive --yes-i-accept-third-party-software --yes",
    );
    expect(r.code).toBe(1);
    expect(r.out.includes("setup-spark` is deprecated")).toBeTruthy();
    expect(r.out.includes("Use `nemoclaw onboard` instead")).toBeTruthy();
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
  });

  it("deploy --help exits 0 and shows deprecated usage", () => {
    const r = run("deploy --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("deploy [instance-name]");
    expect(r.out).toContain("Deprecated Brev-specific bootstrap path");
  });

  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it("debug --quick exits 0 and produces diagnostic output", testTimeoutOptions(30_000), () => {
    const r = runWithEnv(
      "debug --quick",
      createDebugCommandTestEnv("nemoclaw-cli-debug-quick-"),
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
    expect(r.out.includes("System")).toBeTruthy();
    expect(r.out.includes("Onboard Session")).toBeTruthy();
    expect(r.out.includes("Done")).toBeTruthy();
  });

  it.skipIf(os.platform() !== "linux")(
    "debug --quick explains restricted dmesg instead of printing raw stderr on Linux",
    testTimeoutOptions(30_000),
    () => {
      const env = createDebugCommandTestEnv("nemoclaw-cli-debug-dmesg-");
      const localBin = env.PATH?.split(path.delimiter)[0];
      if (!localBin) throw new Error("Expected debug test PATH to include a fake bin dir");
      fs.writeFileSync(
        path.join(localBin, "dmesg"),
        [
          "#!/bin/sh",
          "echo 'dmesg: read kernel buffer failed: Operation not permitted' >&2",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("debug --quick", env, 30000);

      expect(r.code).toBe(0);
      expect(r.out).toContain("Kernel Messages");
      expect(r.out).toContain("kernel messages skipped");
      expect(r.out).toContain("dmesg access is restricted");
      expect(r.out).not.toContain("dmesg: read kernel buffer failed: Operation not permitted");
    },
  );

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Nonexistent flag: --quik");
  });

  it("debug --output without a path is rejected by oclif", () => {
    const r = run("debug --output");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Flag --output expects a value");
  });

  it("help mentions debug command", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it("debug --sandbox NAME targets the specified sandbox", testTimeoutOptions(30_000), () => {
    const r = runWithEnv(
      "debug --quick --sandbox mybox",
      createDebugCommandTestEnv("nemoclaw-cli-debug-sandbox-", { extraSandboxNames: ["mybox"] }),
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
  });

  it("debug --sandbox NAME rejects an unregistered name and exits non-zero", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-debug-unknown-"));
    writeSandboxRegistry(home);
    const tarball = path.join(home, "out.tar.gz");
    const r = runWithEnv(
      `debug --sandbox does-not-exist --output ${tarball} 2>&1`,
      { HOME: home },
      30000,
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does-not-exist");
    expect(r.out).toContain("not registered");
    expect(fs.existsSync(tarball)).toBe(false);
  });

  it(
    "debug --sandbox NAME rejects a stale registry entry missing from the live gateway",
    testTimeoutOptions(30_000),
    () => {
      // Same fixture pattern as createDebugCommandTestEnv but with an openshell
      // stub whose live list intentionally omits the registry name, mirroring
      // the bug where the local registry kept a name the gateway no longer
      // serves.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-debug-stale-"));
      const localBin = path.join(home, "bin");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home, "stale-box");
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          "  echo 'NAME'",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      const tarball = path.join(home, "out.tar.gz");
      const r = runWithEnv(
        `debug --sandbox stale-box --output ${tarball} 2>&1`,
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        30000,
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("stale-box");
      expect(r.out).toContain("not registered");
      expect(fs.existsSync(tarball)).toBe(false);
    },
  );

  it("debug --sandbox without a name exits 1", () => {
    const r = run("debug --sandbox");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--sandbox");
  });

  it("debug warns when default sandbox is stale", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: "ghost" }),
      { mode: 0o600 },
    );
    const r = runWithEnv("debug --quick 2>&1", { HOME: home }, 30000);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Warning");
    expect(r.out).toContain("ghost");
    expect(r.out).toContain("--sandbox NAME");
  });

  it("debug --sandbox skips stale default warning", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          mybox: {
            name: "mybox",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "ghost",
      }),
      { mode: 0o600 },
    );
    // Fake openshell so the live-list check sees `mybox`. Without this the
    // host's real openshell (or absence thereof) decides the assertion.
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME'",
        "  echo 'mybox      Ready'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const r = runWithEnv(
      "debug --quick --sandbox mybox 2>&1",
      { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("default sandbox 'ghost'");
    expect(r.out).not.toContain("--sandbox NAME");
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
  });
});
