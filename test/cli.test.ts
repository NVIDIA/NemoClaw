// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function run(args) {
  return runWithEnv(args);
}

function runWithEnv(args, env = {}, timeout = 10000) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout,
      env: {
        ...process.env,
        HOME: "/tmp/nemoclaw-cli-test-" + Date.now(),
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("CLI dispatch", () => {
  it("help exits 0 and shows sections", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Getting Started")).toBeTruthy();
    expect(r.out.includes("Sandbox Management")).toBeTruthy();
    expect(r.out.includes("Policy Presets")).toBeTruthy();
    expect(r.out.includes("Compatibility Commands")).toBeTruthy();
  });

  it("--help exits 0", () => {
    expect(run("--help").code).toBe(0);
  });

  it("-h exits 0", () => {
    expect(run("-h").code).toBe(0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    expect(r.code).toBe(0);
    expect(r.out.includes("nemoclaw")).toBeTruthy();
  });

  it("unknown command exits 1", () => {
    const r = run("boguscmd");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command")).toBeTruthy();
  });

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("start does not prompt for NVIDIA_API_KEY before launching local services", () => {
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

    const r = runWithEnv("start", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NVIDIA_API_KEY: "",
      TELEGRAM_BOT_TOKEN: "",
    });

    expect(r.code).toBe(0);
    expect(r.out).not.toContain("NVIDIA API Key required");
    // Services module now runs in-process (no bash shelling)
    expect(r.out).toContain("NemoClaw Services");
  });

  it("onboard --help exits 0 and shows usage", () => {
    const r = run("onboard --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Usage: nemoclaw onboard")).toBeTruthy();
    expect(r.out.includes("--from <Dockerfile>")).toBeTruthy();
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option")).toBeTruthy();
  });

  it("accepts onboard --resume in CLI parsing", () => {
    const r = run("onboard --resume --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
  });

  it("accepts the third-party software flag in onboard CLI parsing", () => {
    const r = run("onboard --yes-i-accept-third-party-software --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
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
    expect(r.code).toBe(1);
    expect(r.out.includes("deprecated")).toBeTruthy();
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
  });

  it("setup forwards --resume into onboard parsing", () => {
    const r = run("setup --resume --non-interactive --yes-i-accept-third-party-software");
    expect(r.code).toBe(1);
    expect(r.out.includes("deprecated")).toBeTruthy();
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
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
    const r = run("setup-spark --resume --non-interactive --yes-i-accept-third-party-software");
    expect(r.code).toBe(1);
    expect(r.out.includes("setup-spark` is deprecated")).toBeTruthy();
    expect(r.out.includes("Use `nemoclaw onboard` instead")).toBeTruthy();
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
  });

  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it("debug --quick exits 0 and produces diagnostic output", { timeout: 15000 }, () => {
    const r = run("debug --quick");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
    expect(r.out.includes("System")).toBeTruthy();
    expect(r.out.includes("Onboard Session")).toBeTruthy();
    expect(r.out.includes("Done")).toBeTruthy();
  });

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown option")).toBeTruthy();
  });

  it("help mentions debug command", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it("maps --follow to openshell --tail", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-follow-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "logs-args");
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
        'printf \'%s \' "$@" > "$marker_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha logs --follow", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(markerFile, "utf8")).toContain("logs alpha --tail");
    expect(fs.readFileSync(markerFile, "utf8")).not.toContain("--follow");
  });

  it("destroys the gateway runtime when the last sandbox is removed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "bash.log");
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
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "bash"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("NAME STATUS");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).toContain("docker volume ls -q --filter");
  });

  it("keeps the gateway runtime when other sandboxes still exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "bash.log");
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
          beta: {
            name: "beta",
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
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "bash"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("docker volume ls -q --filter");
    }
  });

  it("keeps the gateway runtime when the live gateway still reports sandboxes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-live-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "bash.log");
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
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "bash"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("beta Ready");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("docker volume ls -q --filter");
    }
  });

  it("fails destroy when openshell sandbox delete returns a real error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-failure-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
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
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  echo "transport error: gateway unavailable" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("transport error: gateway unavailable");
    expect(r.out).toContain("Failed to destroy sandbox 'alpha'.");
    expect(r.out).not.toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeTruthy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
  });

  it("treats an already-missing sandbox as destroyed and clears the stale registry entry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-missing-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "bash.log");
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
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  printf \'%s\\n\' "$*" >> "$log_file"',
        '  echo "Error: status: Not Found, message: \\"sandbox not found\\"" >&2',
        "  exit 1",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        '  printf "NAME STATUS\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "bash"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("already absent from the live gateway");
    expect(r.out).toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeFalsy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).toContain("docker volume ls -q --filter");
  });

  it("deletes messaging providers when destroying a sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-providers-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "bash.log");
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
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "bash"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(openshellLog, "utf8");
    expect(log).toContain("provider delete alpha-telegram-bridge");
    expect(log).toContain("provider delete alpha-discord-bridge");
    expect(log).toContain("provider delete alpha-slack-bridge");
  });

  it("passes plain logs through without the tail flag", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-plain-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "logs-args");
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
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        'printf \'%s \' "$@" > "$marker_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha logs", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(markerFile, "utf8")).toContain("logs alpha");
    expect(fs.readFileSync(markerFile, "utf8")).not.toContain("--tail");
  });

  it("prints upgrade guidance when openshell is too old for nemoclaw logs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-old-openshell-"));
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
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.4'",
        "  exit 0",
        "fi",
        "echo \"error: unrecognized subcommand 'logs'\" >&2",
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha logs --follow", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("too old or incompatible with `nemoclaw logs`")).toBeTruthy();
    expect(r.out.includes("Upgrade OpenShell by rerunning `nemoclaw onboard`")).toBeTruthy();
  });

  it("connect does not pre-start a duplicate port forward", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-forward-"));
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
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
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

    expect(r.code).toBe(0);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox connect alpha");
    expect(calls.some((call) => call.startsWith("forward start --background 18789"))).toBe(false);
  });

  it("removes stale registry entries when connect targets a missing live sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-connect-"));
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
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Removed stale local registry entry")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeUndefined();
  });

  it("recovers a missing registry entry from the last onboard session during list", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-session-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'No sandboxes found.'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
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
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("imports additional live sandboxes into the registry during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-live-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'beta        Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
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
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(
      r.out.includes("Recovered 1 sandbox entry from the live OpenShell gateway."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("beta")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.beta).toBeTruthy();
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("skips invalid recovered sandbox names during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-invalid-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "Alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'Bad_Name    Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
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
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("Bad_Name")).toBeFalsy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.Bad_Name).toBeUndefined();
    expect(saved.sandboxes.Alpha).toBeUndefined();
    expect(saved.sandboxes.gamma).toBeTruthy();
  });

  it("connect recovers a named sandbox from the last onboard session when the registry is empty", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-recover-session-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "connect-args");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
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
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'No sandboxes found.'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
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

    expect(r.code).toBe(0);
    const log = fs.readFileSync(markerFile, "utf8");
    expect(log.includes("sandbox list")).toBeTruthy();
    expect(log.includes("sandbox get alpha")).toBeTruthy();
    expect(log.includes("sandbox connect alpha")).toBeTruthy();
  });

  it("connect keeps the unknown command path when recovery cannot find the requested sandbox", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-unknown-after-recovery-"),
    );
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
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
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'No sandboxes found.'",
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("beta connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command: beta")).toBeTruthy();
    expect(r.out.includes("Try: nemoclaw <sandbox-name> connect")).toBeTruthy();
  });

  it("preserves SIGINT exit semantics for logs --follow", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-sigint-"));
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
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "kill -INT $$",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [CLI, "alpha", "logs", "--follow"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
    });

    expect(result.status).toBe(130);
  });

  it("keeps registry entries when status hits a gateway-level transport error", () => {
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
      10000,
    );

    expect(r.code).toBe(0);
    expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
    expect(r.out.includes("gateway identity drift after restart")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
  }, 10000);

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
        '    -w|--connect-timeout|--max-time) shift 2 ;;',
        '    -s|-S|-sS|-f) shift ;;',
        '    http://*|https://*) url="$1"; shift ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'if [ -n "$out" ]; then : > "$out"; fi',
        'if echo "$url" | grep -q "11434/api/tags"; then',
        '  printf "000"',
        '  exit 7',
        'fi',
        'printf "000"',
        'exit 7',
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Inference:");
    expect(r.out).toContain("unreachable");
    expect(r.out).toContain("Start Ollama and retry");
    expect(r.out).toContain("http://localhost:11434/api/tags");
  });

  it("does not treat a different connected gateway as a healthy nemoclaw gateway", () => {
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
      10000,
    );

    expect(r.code).toBe(0);
    expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeFalsy();
    expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
    expect(r.out.includes("verify the active gateway")).toBeTruthy();
  }, 10000);

  it("matches ANSI-decorated gateway transport errors when printing lifecycle hints", () => {
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
      10000,
    );

    expect(r.code).toBe(0);
    expect(r.out.includes("current gateway/runtime is not reachable")).toBeTruthy();
  }, 10000);

  it("matches ANSI-decorated gateway auth errors when printing lifecycle hints", () => {
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
      10000,
    );

    expect(r.code).toBe(0);
    expect(
      r.out.includes("Verify the active gateway and retry after re-establishing the runtime."),
    ).toBeTruthy();
  }, 10000);

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
      10000,
    );
    expect(statusResult.code).toBe(0);
    expect(statusResult.out.includes("gateway trust material rotated after restart")).toBeTruthy();
    expect(statusResult.out.includes("cannot be reattached safely")).toBeTruthy();

    const connectResult = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(connectResult.code).toBe(1);
    expect(connectResult.out.includes("gateway trust material rotated after restart")).toBeTruthy();
    expect(connectResult.out.includes("Recreate this sandbox")).toBeTruthy();
  });

  it("explains when gateway metadata exists but the restarted API is still refusing connections", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-unreachable-"));
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

    const statusResult = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      10000,
    );
    expect(statusResult.code).toBe(0);
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
  }, 10000);

  it("explains when the named gateway is no longer configured after restart or rebuild", () => {
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
      10000,
    );
    expect(statusResult.code).toBe(0);
    expect(
      statusResult.out.includes("gateway is no longer configured after restart/rebuild"),
    ).toBeTruthy();
    expect(statusResult.out.includes("Start the gateway again")).toBeTruthy();
  }, 10000);
});

describe("list shows live gateway inference", () => {
  it("shows stored sandbox inference instead of live gateway inference", () => {
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
    expect(r.out).toContain("configured-model");
    expect(r.out).toContain("configured-provider");
    expect(r.out).not.toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(r.out).not.toContain("nvidia-prod");
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
});
