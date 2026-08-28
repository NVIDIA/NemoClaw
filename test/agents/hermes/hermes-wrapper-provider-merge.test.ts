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

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER, canRun, runWrapper } from "../../helpers/hermes-wrapper-harness.ts";

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.py provider/model merge", () => {
  it("merges separate --provider and -m flags into the combined form (#7361)", () => {
    const run = runWrapper(["--provider", "opencode-zen", "-m", "nemotron-3-ultra-free"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "opencode-zen/nemotron-3-ultra-free"]);
  });

  it("merges after an unknown atomic top-level option (#8011)", () => {
    const run = runWrapper(
      ["--future-flag", "--provider", "nvidia-prod", "--model", "nvidia/model"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["--future-flag", "--model", "nvidia-prod/nvidia/model"]);
  });

  it("passes through when an unknown option may own positional data (#8011)", () => {
    const argv = [
      "--future-option",
      "future-value",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/model",
    ];

    expect(runWrapper(argv, {}).realArgv).toEqual(argv);
  });

  it("preserves a namespaced model while merging its separate provider (#7361)", () => {
    const run = runWrapper(
      ["--provider", "nvidia-prod", "--model", "nvidia/nemotron-3-super-120b-a12b"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["--model", "nvidia-prod/nvidia/nemotron-3-super-120b-a12b"]);
  });

  it("drops a redundant provider from a model already prefixed with it (#7361)", () => {
    const run = runWrapper(
      ["--provider", "opencode-zen", "-m", "opencode-zen/already-prefixed"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "opencode-zen/already-prefixed"]);
  });

  it("matches an existing provider prefix case-insensitively (#7361)", () => {
    const run = runWrapper(
      ["--provider", "OPENCODE-ZEN", "-m", "opencode-zen/already-prefixed"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(["-m", "opencode-zen/already-prefixed"]);
  });

  it.each(["-c", "--continue"])(
    "merges after value-less short and long continue flags [case %#] (#7361)",
    (continueFlag) => {
      const run = runWrapper(
        [continueFlag, "--provider", "nvidia-prod", "--model", "nvidia/nemotron-3-super-120b-a12b"],
        {},
      );

      expect(run.status).toBe(0);
      expect(run.realArgv).toEqual([
        continueFlag,
        "--model",
        "nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
      ]);
    },
  );

  it("rejects an ambiguous unquoted multi-word continue form (#8011)", () => {
    const argv = [
      "-c",
      "Pokemon",
      "Agent",
      "Dev",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/nemotron-3-super-120b-a12b",
    ];
    const run = runWrapper(argv, {});

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("ambiguous session name");
  });

  it("merges after a quoted multi-word continue session name (#8011)", () => {
    const run = runWrapper(
      [
        "-c",
        "Pokemon Agent Dev",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "-c",
      "Pokemon Agent Dev",
      "--model",
      "nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("passes an upstream session boundary through without merging provider/model (#8011)", () => {
    const argv = [
      "-c",
      "sessions",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/nemotron-3-super-120b-a12b",
    ];
    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("rejects an ambiguous unquoted multi-word resume form (#8011)", () => {
    const argv = [
      "-r",
      "My",
      "Session",
      "Name",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/nemotron-3-super-120b-a12b",
    ];
    const run = runWrapper(argv, {});

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("ambiguous session name");
  });

  it("merges after a quoted multi-word resume session name (#8011)", () => {
    const run = runWrapper(
      [
        "-r",
        "My Session Name",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "-r",
      "My Session Name",
      "--model",
      "nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("merges a top-level model after the inherited long profile flag (#7361)", () => {
    const run = runWrapper(
      [
        "--profile",
        "work",
        "-z",
        "hello",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "--profile",
      "work",
      "-z",
      "hello",
      "--model",
      "nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("merges after the Hermes 0.19 usage report flag (#7361)", () => {
    const run = runWrapper(
      [
        "--usage-file",
        "/tmp/hermes-usage.json",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "--usage-file",
      "/tmp/hermes-usage.json",
      "--model",
      "nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("merges a namespaced model for the supported chat command (#7361)", () => {
    const run = runWrapper(
      [
        "-p",
        "work",
        "chat",
        "--query",
        "hello",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "-p",
      "work",
      "chat",
      "--query",
      "hello",
      "--model",
      "nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("rejects ambiguous session text before provider/model flags owned by another command (#8011)", () => {
    const argv = [
      "-c",
      "my",
      "project",
      "sessions",
      "export",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/nemotron-3-super-120b-a12b",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("ambiguous session name");
  });

  it("passes a new upstream command through without an adapter release (#8011)", () => {
    const argv = [
      "future-command",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/nemotron-3-super-120b-a12b",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("passes provider/model-looking arguments after -- through unchanged (#8011)", () => {
    const argv = [
      "--resume",
      "my",
      "project",
      "--",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/nemotron-3-super-120b-a12b",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("rejects an unknown adapter version before invoking Hermes (#8011)", () => {
    const adapter = JSON.parse(fs.readFileSync(ADAPTER, "utf-8"));
    adapter.adapter_version = 2;

    const run = runWrapper(
      ["--provider", "nvidia-prod", "--model", "nvidia/nemotron-3-super-120b-a12b"],
      {},
      { adapter },
    );

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("unsupported Hermes CLI adapter version: 2");
  });

  it("rejects an unknown upstream CLI version before translating (#8011)", () => {
    const run = runWrapper(
      ["--provider", "nvidia-prod", "--model", "nvidia/nemotron-3-super-120b-a12b"],
      {},
      { upstreamVersion: "0.20.0" },
    );

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("adapter targets Hermes 0.19.0");
    expect(run.stderr).toContain("installed CLI reports 0.20.0");
  });

  it("rejects ambiguous continuation text before the Hermes 0.19 console command (#8011)", () => {
    const argv = [
      "-c",
      "my",
      "project",
      "console",
      "list",
      "--provider",
      "nvidia-prod",
      "--model",
      "nvidia/nemotron-3-super-120b-a12b",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("ambiguous session name");
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
