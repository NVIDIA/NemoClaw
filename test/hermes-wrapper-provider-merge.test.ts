// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the hermes CLI wrapper's provider/model flag merging
// (agents/hermes/hermes-wrapper.py, #7361): separate --provider and -m/--model
// flags must be merged into the combined provider/model form so the invocation
// routes through the OpenShell proxy rewrite path that resolves credential
// placeholders.
//
// Linux + python3 gated: the wrapper is a Python script invoked via its
// `#!/usr/bin/python3 -I` shebang. CI runs on Linux with python3 available, so
// the suite runs every PR; the gate exists so a maintainer cloning on macOS or
// Windows does not see a spurious red on `npm test`. See `.github/workflows/`
// for the canonical CI runner image.

import { describe, expect, it } from "vitest";

import { canRun, runWrapper } from "./helpers/hermes-wrapper-harness.ts";

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.py provider/model merge", () => {
  it("merges separate --provider and -m flags into the combined form (#7361)", () => {
    const run = runWrapper(["--provider", "opencode-zen", "-m", "nemotron-3-ultra-free"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "opencode-zen/nemotron-3-ultra-free"]);
  });

  it("passes through model that already contains a slash (#7361)", () => {
    const run = runWrapper(
      ["--provider", "opencode-zen", "-m", "opencode-zen/already-prefixed"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "--provider",
      "opencode-zen",
      "-m",
      "opencode-zen/already-prefixed",
    ]);
  });

  it("passes through --provider alone without -m (#7361)", () => {
    const run = runWrapper(["--provider", "opencode-zen"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["--provider", "opencode-zen"]);
  });

  it("passes through -m alone without --provider (#7361)", () => {
    const run = runWrapper(["-m", "nemotron-3-ultra-free"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "nemotron-3-ultra-free"]);
  });

  it("merges equals-form --provider and --model flags (#7361)", () => {
    const run = runWrapper(["--provider=opencode-zen", "--model=some-model"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["--model=opencode-zen/some-model"]);
  });

  it("merges when model appears before provider (#7361)", () => {
    const run = runWrapper(["-m", "nemotron-3-ultra-free", "--provider", "opencode-zen"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "opencode-zen/nemotron-3-ultra-free"]);
  });

  it("passes through empty provider value (#7361)", () => {
    const run = runWrapper(["--provider", "", "-m", "nemotron-3-ultra-free"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["--provider", "", "-m", "nemotron-3-ultra-free"]);
  });

  it("passes through combined form without --provider (#7361)", () => {
    const run = runWrapper(["-m", "opencode-zen/nemotron-3-ultra-free"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "opencode-zen/nemotron-3-ultra-free"]);
  });

  it("passes through duplicate provider flags as ambiguous (#7361)", () => {
    const argv = [
      "--provider=opencode-zen",
      "--provider",
      "opencode-zen",
      "-m",
      "nemotron-3-ultra-free",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("passes through mixed duplicate model flags as ambiguous (#7361)", () => {
    const argv = [
      "--provider",
      "opencode-zen",
      "-m",
      "nemotron-3-ultra-free",
      "--model=nemotron-3-ultra-free",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("merges flags before -- and preserves arguments after (#7361)", () => {
    const run = runWrapper(
      ["--provider", "opencode-zen", "-m", "nemotron-3-ultra-free", "--", "extra"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "opencode-zen/nemotron-3-ultra-free", "--", "extra"]);
  });

  it("does not merge flags that appear only after -- (#7361)", () => {
    const run = runWrapper(["--", "--provider", "opencode-zen", "-m", "nemotron-3-ultra-free"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "--",
      "--provider",
      "opencode-zen",
      "-m",
      "nemotron-3-ultra-free",
    ]);
  });
});
