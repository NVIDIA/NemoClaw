// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PARSER_EXIT_CODE, run, runWithEnv } from "./helpers";

function writeOpenShellVersionStub(localBin: string): void {
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--version" ]; then echo "openshell 0.0.37"; exit 0; fi',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function writeIncompleteResumeSession(nemoclawDir: string): void {
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
}

describe("CLI onboard compatibility", () => {
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
    writeOpenShellVersionStub(localBin);
    // Simulates a pre-fix on-disk session that recorded only provider/model
    // (with #2753's onboard fix, sandboxName is no longer written here either).
    writeIncompleteResumeSession(nemoclawDir);

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
    writeOpenShellVersionStub(localBin);
    writeIncompleteResumeSession(nemoclawDir);

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
});
