// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Hermes 0.21.3 owns resumed and continued one-shot session persistence.
// These tests keep that retired compatibility surface on the native CLI path.

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER, canRun, runWrapper } from "../../helpers/hermes-wrapper-harness.ts";

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.py native one-shot routing", () => {
  it("passes a resumed one-shot through to Hermes 0.21.3 unchanged (#5254)", () => {
    const argv = [
      "--resume",
      "20260612_050401_aa9d27",
      "--oneshot",
      "What secret number did I give you?",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("passes a continued one-shot usage report through unchanged (#5254)", () => {
    const argv = [
      "--continue",
      "daily check",
      "--oneshot=Summarize the latest turn",
      "--usage-file",
      "/tmp/usage.json",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("retains provider/model composition without restoring resumed routing (#7361)", () => {
    const run = runWrapper(
      [
        "--continue",
        "daily check",
        "--oneshot",
        "Summarize the latest turn",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/model",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "--continue",
      "daily check",
      "--oneshot",
      "Summarize the latest turn",
      "--model",
      "nvidia-prod/nvidia/model",
    ]);
  });

  it("rejects a CLI adapter that restores the retired translation (#5254)", () => {
    const adapter = JSON.parse(fs.readFileSync(ADAPTER, "utf8"));
    adapter.translations.resumed_oneshot = {
      issue: 5254,
      forms: ["retired"],
      reason: "retired",
      removal_condition: "retired",
      source_fix_constraint: "retired",
    };

    const run = runWrapper(["--continue", "--oneshot", "hello"], {}, { adapter });

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("invalid translation metadata");
  });
});
