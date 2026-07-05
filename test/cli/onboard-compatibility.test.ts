// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OnboardCliCommand from "../../src/commands/onboard";
import SetupCliCommand from "../../src/commands/setup";
import SetupSparkCliCommand from "../../src/commands/setup-spark";
import { runOnboardAction } from "../../src/lib/actions/global";

import { PARSER_EXIT_CODE, run, runWithEnv } from "./helpers";

vi.mock("../../src/lib/agent/defs", () => ({
  listAgents: vi.fn(() => ["openclaw", "hermes", "langchain-deepagents-code"]),
}));

vi.mock("../../src/lib/actions/global", () => ({
  runOnboardAction: vi.fn().mockResolvedValue(undefined),
}));

const rootDir = process.cwd();
let previousExitCode: typeof process.exitCode;

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
  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("onboard --help exits 0 and shows usage", () => {
    // Keep one real executable help contract so command discovery, oclif rendering,
    // and the CommonJS launcher remain covered together.
    const r = run("onboard --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    expect(r.out).toContain("nemoclaw onboard");
    expect(r.out).toContain("--from <Dockerfile>");
    expect(r.out).toContain("--yes");
    expect(r.out).toContain("--sandbox-gpu-device=<value>");
    expect(r.out).toContain(
      "Agent runtime to onboard (openclaw, hermes, langchain-deepagents-code;",
    );
    expect(r.out).toContain("aliases: nemohermes → hermes;");
    expect(r.out).toContain("nemo-deepagents/dcode/deepagents/deepagents-code/langchain →");
    expect(r.out).toContain("langchain-deepagents-code)");
  });

  it("unknown onboard option exits 1", () => {
    // Keep one real parser-exit contract to pin launcher argv and exit-code propagation.
    const r = run("onboard --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("accepts onboard --resume in CLI parsing", async () => {
    await expect(OnboardCliCommand.run(["--resume", "--non-interactiv"], rootDir)).rejects.toThrow(
      "Nonexistent flag: --non-interactiv",
    );
    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("accepts the third-party software flag in onboard CLI parsing", async () => {
    await expect(
      OnboardCliCommand.run(["--yes-i-accept-third-party-software", "--non-interactiv"], rootDir),
    ).rejects.toThrow("Nonexistent flag: --non-interactiv");
    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("accepts install automation --yes in onboard CLI parsing", async () => {
    await OnboardCliCommand.run(
      ["--resume", "--non-interactive", "--yes-i-accept-third-party-software", "--yes"],
      rootDir,
    );

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        "non-interactive": true,
        resume: true,
        "yes-i-accept-third-party-software": true,
        yes: true,
      }),
    );
  });

  it("lets oclif reject conflicting sandbox GPU flags", async () => {
    await expect(
      OnboardCliCommand.run(
        [
          "--sandbox-gpu",
          "--no-sandbox-gpu",
          "--non-interactive",
          "--yes-i-accept-third-party-software",
          "--yes",
        ],
        rootDir,
      ),
    ).rejects.toThrow(/--no-sandbox-gpu=true cannot also be provided.*--sandbox-gpu/s);
    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("lets oclif enforce the sandbox GPU device dependency", async () => {
    await expect(
      OnboardCliCommand.run(
        [
          "--sandbox-gpu-device",
          "nvidia.com/gpu=0",
          "--no-sandbox-gpu",
          "--non-interactive",
          "--yes-i-accept-third-party-software",
          "--yes",
        ],
        rootDir,
      ),
    ).rejects.toThrow(/must be provided when using --sandbox-gpu-device: --sandbox-gpu/);
    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("lets oclif reject privileged control UI ports", async () => {
    await expect(OnboardCliCommand.run(["--control-ui-port", "80"], rootDir)).rejects.toThrow(
      "Expected an integer greater than or equal to 1024 but received: 80",
    );
    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("setup --help exits 0 and shows native deprecated-alias usage", () => {
    // Keep one real alias-help rendering contract; the other aliases can use their
    // command metadata and typed action seam directly.
    const r = run("setup --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Deprecated: 'nemoclaw setup' is now 'nemoclaw onboard'");
    expect(r.out).toContain("$ nemoclaw setup [flags]");
    expect(r.out).not.toContain("Unknown onboard option");
  });

  it("setup rejects unknown options through oclif", async () => {
    await expect(SetupCliCommand.run(["--non-interactiv"], rootDir)).rejects.toThrow(
      "Nonexistent flag: --non-interactiv",
    );
    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("setup forwards --resume into the shared onboard action", async () => {
    await SetupCliCommand.run(
      ["--resume", "--non-interactive", "--yes-i-accept-third-party-software", "--yes"],
      rootDir,
    );

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        "non-interactive": true,
        resume: true,
        "yes-i-accept-third-party-software": true,
        yes: true,
      }),
    );
  });

  it("resume rejection clarifies --resume semantics and points to onboard (#2281)", () => {
    // Keep the real executable/runtime exit contract for the user-facing diagnostic.
    const r = run("onboard --resume --non-interactive --yes-i-accept-third-party-software --yes");
    expect(r.code).toBe(1);
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
    expect(r.out.includes("--resume only continues an interrupted onboarding run")).toBeTruthy();
    expect(
      r.out.includes("To change configuration on an existing sandbox, rebuild it"),
    ).toBeTruthy();
    expect(r.out.includes("nemoclaw onboard")).toBeTruthy();
  });

  it("does not let whitespace-only NEMOCLAW_SANDBOX_NAME satisfy the resume guard (#2753)", () => {
    // Preserve one full environment-ingest boundary: HOME/session discovery,
    // whitespace normalization, OpenShell executable lookup, and final exit.
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

    const r = runWithEnv("onboard --resume --non-interactive --yes-i-accept-third-party-software", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_SANDBOX_NAME: "   ",
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Cannot resume non-interactive onboard")).toBeTruthy();
  });

  it("setup-spark --help exits 0 and shows native deprecated-alias usage", () => {
    const r = run("setup-spark --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Deprecated: 'nemoclaw setup-spark' is now 'nemoclaw onboard'");
    expect(r.out).toContain("$ nemoclaw setup-spark [flags]");
    expect(r.out).not.toContain("Unknown onboard option");
  });

  it("setup-spark is a deprecated compatibility alias for onboard", async () => {
    await SetupSparkCliCommand.run(
      ["--resume", "--non-interactive", "--yes-i-accept-third-party-software", "--yes"],
      rootDir,
    );

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        "non-interactive": true,
        resume: true,
        "yes-i-accept-third-party-software": true,
        yes: true,
      }),
    );
  });

  it("deploy --help exits 0 and shows deprecated usage", () => {
    const r = run("deploy --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("deploy [instance-name]");
    expect(r.out).toContain("Deprecated Brev-specific bootstrap path");
  });
});
