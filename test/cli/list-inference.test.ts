// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HERMES_CLI,
  execTimeout,
  isCliErrorCandidate,
  readBufferOrStringProperty,
  readCliErrorOutput,
  run,
  runWithEnv,
} from "./helpers";

describe("CLI dispatch", () => {
  it("redirects `inference set` to openshell when provider or model is missing", () => {
    for (const argv of [
      "inference set 2>&1",
      "inference set --provider nvidia-prod 2>&1",
      "inference set --model nvidia/model 2>&1",
    ]) {
      const r = run(argv);
      expect(r.code, `nemoclaw ${argv}`).toBe(1);
      expect(r.out, `nemoclaw ${argv}`).toContain("Unknown nemoclaw command: inference set");
      expect(r.out, `nemoclaw ${argv}`).toContain("This operation belongs to OpenShell.");
      expect(r.out, `nemoclaw ${argv}`).toContain(
        "Run: openshell inference set -g nemoclaw --model <model> --provider <provider>",
      );
      expect(r.out, `nemoclaw ${argv}`).not.toContain("Missing required flag");
      expect(r.out, `nemoclaw ${argv}`).not.toContain("FailedFlagValidationError");
      expect(r.out, `nemoclaw ${argv}`).not.toContain("node_modules/@oclif/core");
    }

    let hermesOut = "";
    let hermesCode = 0;
    try {
      hermesOut = execSync(`node "${HERMES_CLI}" inference set 2>&1`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: execTimeout(),
        env: {
          ...process.env,
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
        },
      });
    } catch (err) {
      const result = readCliErrorOutput(
        isCliErrorCandidate(err)
          ? {
              status: typeof err.status === "number" ? err.status : undefined,
              stdout: readBufferOrStringProperty(err, "stdout"),
              stderr: readBufferOrStringProperty(err, "stderr"),
            }
          : String(err),
      );
      hermesOut = result.out;
      hermesCode = result.code;
    }
    expect(hermesCode).toBe(1);
    expect(hermesOut).toContain("Unknown nemohermes command: inference set");
    expect(hermesOut).toContain("This operation belongs to OpenShell.");
    expect(hermesOut).toContain(
      "Run: openshell inference set -g nemoclaw --model <model> --provider <provider>",
    );
  });

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("list --help exits 0 and shows list usage", () => {
    const r = run("list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("list [--json]");
    expect(r.out).toContain("List all sandboxes");
  });

  it("nemohermes list --help uses alias branding", () => {
    const out = execSync(`node "${HERMES_CLI}" list --help`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
      },
    });
    expect(out).toContain("$ nemohermes list [--json]");
    expect(out).not.toContain("$ nemoclaw list [--json]");
  });

  it("nemohermes inference set --help uses alias branding and agent-aware wording", () => {
    const out = execSync(`node "${HERMES_CLI}" inference set --help`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
      },
    });
    expect(out).toContain("$ nemohermes inference set --provider <provider> --model <model>");
    expect(out).toContain("[--sandbox <name>] [--no-verify]");
    expect(out).toMatch(/OpenClaw or Hermes\s+sandbox config/);
  });

  it("inference set rejects empty provider values during oclif parsing", () => {
    const result = run("inference set --provider '' --model nvidia/model");
    expect(result.code).toBe(1);
    expect(result.out).toContain("Parsing --provider");
    expect(result.out).toContain("OpenShell inference provider name cannot be empty");
  });

  it("inference get reports the live NemoClaw gateway route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inference-get-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron-3-super-120b-a12b'",
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const text = runWithEnv("inference get", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(text.code).toBe(0);
      expect(text.out).toContain("Provider: nvidia-prod");
      expect(text.out).toContain("Model:    nvidia/nemotron-3-super-120b-a12b");

      const json = runWithEnv("inference get --json", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out)).toEqual({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("list --json emits structured empty inventory", () => {
    const r = run("list --json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: null,
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [],
    });
  });

  it("list --json emits structured sandbox details", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-json-"));
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
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi"],
            agent: "openclaw",
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
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ps"),
      ["#!/bin/sh", "echo '123 ssh openshell-alpha'", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [
        {
          name: "alpha",
          model: "configured-model",
          provider: "configured-provider",
          gpuEnabled: true,
          policies: ["pypi"],
          agent: "openclaw",
          isDefault: true,
          activeSessionCount: 1,
          connected: true,
          hostGpuDetected: false,
          sandboxGpuEnabled: true,
          sandboxGpuMode: null,
          sandboxGpuDevice: null,
          openshellDriver: null,
          openshellVersion: null,
        },
      ],
    });
  });

  it("list forwards oclif parse errors for unknown options", () => {
    const r = run("list --bogus");
    expect(r.code).toBe(2);
    expect(r.out.includes("Nonexistent flag: --bogus")).toBeTruthy();
    expect(r.out.includes("See more help with --help")).toBeTruthy();
  });

});
