// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the hermes CLI wrapper's one-shot routing translation
// (agents/hermes/hermes-wrapper.py, #5254): resumed/continued one-shot
// invocations must be rewritten through `chat --query` so Hermes appends to the
// target session, while ambiguous or non-matching argv is passed straight
// through unchanged. Split out of test/agents/hermes/hermes-gateway-wrapper.test.ts to keep
// each file within the test-file-size budget.
//
// Linux + python3 gated: the wrapper is a Python script invoked via its
// `#!/usr/bin/python3 -I` shebang. CI runs on Linux with python3 available, so
// the suite runs every PR; the gate exists so a maintainer cloning on macOS or
// Windows does not see a spurious red on `npm test`. See `.github/workflows/`
// for the canonical CI runner image.

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ADAPTER,
  canRun,
  runWrapper,
  WRAPPER,
  writeSessionCoalescerFixture,
} from "../../helpers/hermes-wrapper-harness.ts";

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.py one-shot routing", () => {
  // Surface a hard error in CI when the prerequisites are missing instead of
  // silently skipping — a green CI run that never executed any wrapper test
  // would mask regressions in the security boundary. Runs after
  // `describe.skipIf` evaluates so non-Linux/python-less environments still
  // skip cleanly without failing at module load.
  beforeAll(() => {
    assert(
      !process.env.CI || canRun,
      "Hermes wrapper integration tests require Linux + python3; CI environment did not meet both prerequisites",
    );
  });

  it("routes resumed one-shot invocations through chat query so Hermes appends to the target session (#5254)", () => {
    const run = runWrapper(
      ["--resume", "20260612_050401_aa9d27", "-z", "What secret number did I give you?"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "chat",
      "--query",
      "What secret number did I give you?",
      "--quiet",
      "--resume",
      "20260612_050401_aa9d27",
    ]);
  });

  it("routes continued one-shot invocations through chat query while preserving provider/skill flags (#5254)", () => {
    const run = runWrapper(
      [
        "-c",
        "daily check",
        "--oneshot=Summarize the latest turn",
        "--provider=custom",
        "--skills=memory,session_search",
        "--ignore-rules",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "chat",
      "--query",
      "Summarize the latest turn",
      "--quiet",
      "--continue",
      "daily check",
      "--provider",
      "custom",
      "--skills",
      "memory,session_search",
      "--ignore-rules",
    ]);
  });

  it.each([
    "-c",
    "--continue",
  ])("routes bare %s one-shot invocations to the most recent session (#5254)", (flag) => {
    const run = runWrapper([flag, "-z", "Repeat the latest turn"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "chat",
      "--query",
      "Repeat the latest turn",
      "--quiet",
      "--continue",
    ]);
  });

  it.each([
    ["-c", "--continue"],
    ["--continue", "--continue"],
    ["-r", "--resume"],
    ["--resume", "--resume"],
  ])("coalesces an unquoted multi-word session name after %s (#5254)", (flag, canonical) => {
    const run = runWrapper([flag, "daily", "check", "-z", "Repeat the latest turn"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "chat",
      "--query",
      "Repeat the latest turn",
      "--quiet",
      canonical,
      "daily check",
    ]);
  });

  it("uses Hermes' coalescing boundaries rather than treating the new console command as a session-name boundary (#5254)", () => {
    const run = runWrapper(["--continue", "daily", "console", "-z", "Repeat the latest turn"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "chat",
      "--query",
      "Repeat the latest turn",
      "--quiet",
      "--continue",
      "daily console",
    ]);
  });

  it("passes an upstream session boundary through without translating across it (#8011)", () => {
    const argv = ["--continue", "daily", "gateway", "run", "-z", "Repeat the latest turn"];
    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("passes a new upstream session boundary through without an adapter update (#8011)", () => {
    const argv = ["--continue", "daily", "future-command", "-z", "Repeat the latest turn"];
    const run = runWrapper(argv, {}, { sessionBoundaries: ["chat", "future-command"] });

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("rejects an invalid upstream session boundary source before invoking Hermes (#8011)", () => {
    const run = runWrapper(
      ["--continue", "daily", "-z", "Repeat the latest turn"],
      {},
      {
        sessionBoundaries: [],
      },
    );

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("session-name coalescer boundary set is invalid");
  });

  it.each([
    "--continue",
    "--resume",
  ])("passes an explicit managed command after %s through without translating across its boundary (#8011)", (flag) => {
    const argv = [flag, "daily", "chat", "--oneshot", "Repeat the latest turn"];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it.each([
    [
      ["-p", "work"],
      ["--profile", "work"],
    ],
    [
      ["--profile", "work"],
      ["--profile", "work"],
    ],
    [["--profile=work"], ["--profile", "work"]],
  ])("preserves profile selector %j before translated chat routing (#5254)", (profileArgs, expected) => {
    const run = runWrapper([...profileArgs, "-c", "-z", "Repeat the latest turn"], {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      ...expected,
      "chat",
      "--query",
      "Repeat the latest turn",
      "--quiet",
      "--continue",
    ]);
  });

  it("preserves explicit approval flags without adding them to ordinary resumed one-shot invocations (#5254)", () => {
    const run = runWrapper(
      ["--resume", "20260612_050401_aa9d27", "-z", "Repeat it", "--yolo", "--accept-hooks"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "chat",
      "--query",
      "Repeat it",
      "--quiet",
      "--resume",
      "20260612_050401_aa9d27",
      "--yolo",
      "--accept-hooks",
    ]);
  });

  it("preserves Hermes 0.19 safety flags on resumed one-shot invocations (#5254)", () => {
    const run = runWrapper(
      ["--resume", "20260612_050401_aa9d27", "-z", "Repeat it", "--no-restore-cwd", "--safe-mode"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "chat",
      "--query",
      "Repeat it",
      "--quiet",
      "--resume",
      "20260612_050401_aa9d27",
      "--no-restore-cwd",
      "--safe-mode",
    ]);
  });

  it("refuses a resumed one-shot usage report instead of silently dropping it on the chat translation (#5254)", () => {
    const run = runWrapper(
      [
        "--resume",
        "20260612_050401_aa9d27",
        "-z",
        "Repeat it",
        "--usage-file",
        "/tmp/hermes-usage.json",
      ],
      {},
    );

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("[COMPATIBILITY] Refusing resumed one-shot with --usage-file");
    expect(run.stderr).not.toContain("/tmp/hermes-usage.json");
  });

  it("refuses equals-form usage reports on translated resumed one-shots (#5254)", () => {
    const run = runWrapper(
      [
        "--resume=20260612_050401_aa9d27",
        "--oneshot=Repeat it",
        "--usage-file=/tmp/private-usage.json",
      ],
      {},
    );

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).not.toContain("/tmp/private-usage.json");
  });

  it("refuses usage reports on bare continued one-shots (#5254)", () => {
    const run = runWrapper(
      ["--continue", "-z", "Repeat it", "--usage-file=/tmp/latest-usage.json"],
      {},
    );

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("[COMPATIBILITY] Refusing resumed one-shot with --usage-file");
    expect(run.stderr).not.toContain("/tmp/latest-usage.json");
  });

  it("keeps translated resumed one-shot turns on the same fake session and reports exec failures (#5254)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-session-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.copyFileSync(ADAPTER, path.join(dir, "hermes-cli-adapter-v1.json"));
      writeSessionCoalescerFixture(dir);
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      const statePath = path.join(dir, "sessions.json");
      fs.writeFileSync(
        path.join(dir, "hermes.real"),
        [
          "#!/usr/bin/env bash",
          'if [ "${NEMOCLAW_HERMES_ADAPTER_VERSION_PROBE:-}" = "1" ]; then printf "Hermes Agent v0.20.6\\n"; exit 0; fi',
          'if [ "$1" = "-z" ]; then printf "seed:%s\\n" "$2" > "$NEMOCLAW_FAKE_SESSIONS"; exit 0; fi',
          'if [ "$1" = "chat" ] && [ "$2" = "--query" ] && [ "$4" = "--quiet" ] && { [ "$5" = "--resume" ] || [ "$5" = "--continue" ]; } && [ "$6" = "seed" ]; then printf "seed:%s\\n" "$3" >> "$NEMOCLAW_FAKE_SESSIONS"; exit 0; fi',
          "exit 3",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const invoke = (args: string[]) =>
        spawnSync(path.join(dir, "hermes"), args, {
          encoding: "utf-8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: dir,
            NEMOCLAW_FAKE_SESSIONS: statePath,
          },
          timeout: 10_000,
        });

      expect(invoke(["-z", "seed prompt"]).status).toBe(0);
      expect(invoke(["--resume", "seed", "-z", "resume prompt"]).status).toBe(0);
      expect(invoke(["-c", "seed", "-z", "continue prompt"]).status).toBe(0);
      expect(fs.readFileSync(statePath, "utf-8").trim().split("\n")).toEqual([
        "seed:seed prompt",
        "seed:resume prompt",
        "seed:continue prompt",
      ]);
      fs.chmodSync(path.join(dir, "hermes.real"), 0o644);
      const blocked = invoke(["--resume", "seed", "-z", "after chmod"]);
      expect(blocked.status).toBe(126);
      expect(blocked.stderr).toContain("[SECURITY] Refusing to run hermes: failed to exec Hermes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves plain one-shot invocations on the upstream one-shot path (#5254)", () => {
    const run = runWrapper(["-z", "Reply pong"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("-z Reply pong");
  });

  it("routes equals-style resumed one-shot invocations through chat query (#5254)", () => {
    const run = runWrapper(["--resume=20260612_050401_aa9d27", "--oneshot=Repeat a=b"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("chat --query Repeat a=b --quiet --resume 20260612_050401_aa9d27");
  });

  it("passes positional subcommands through instead of translating nested one-shot flags (#5254)", () => {
    const run = runWrapper(["chat", "--resume", "20260612_050401_aa9d27", "-z", "Repeat it"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("chat --resume 20260612_050401_aa9d27 -z Repeat it");
  });

  it("passes unknown flags through instead of translating a partial allowlist match (#5254)", () => {
    const run = runWrapper(
      ["--resume", "20260612_050401_aa9d27", "--unknown", "-z", "Repeat it"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--resume 20260612_050401_aa9d27 --unknown -z Repeat it");
  });

  it("passes argv with -- marker through instead of translating after argument termination (#5254)", () => {
    const run = runWrapper(["--resume", "20260612_050401_aa9d27", "--", "-z", "Repeat it"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--resume 20260612_050401_aa9d27 -- -z Repeat it");
  });

  it("passes mixed resume selectors through instead of translating ambiguous targets (#5254)", () => {
    const run = runWrapper(
      [
        "--continue",
        "20260612_050401_aa9d27",
        "--resume",
        "20260612_050446_924bd8",
        "-z",
        "Repeat it",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe(
      "--continue 20260612_050401_aa9d27 --resume 20260612_050446_924bd8 -z Repeat it",
    );
  });

  it("passes multiple one-shot prompts through instead of dropping an earlier prompt (#5254)", () => {
    const run = runWrapper(
      ["-z", "First prompt", "-z", "Second prompt", "--resume", "20260612_050401_aa9d27"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("-z First prompt -z Second prompt --resume 20260612_050401_aa9d27");
  });

  it("passes empty one-shot prompts through instead of translating an invalid query (#5254)", () => {
    const run = runWrapper(["--oneshot=", "--resume", "20260612_050401_aa9d27"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--oneshot= --resume 20260612_050401_aa9d27");
  });

  it("passes empty --continue values through instead of translating an invalid selector (#5254)", () => {
    const run = runWrapper(["--continue=", "-z", "Repeat it"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--continue= -z Repeat it");
  });

  it("passes separated --continue with an empty value through instead of translating an invalid selector (#5254)", () => {
    const run = runWrapper(["--continue", "", "-z", "Repeat it"], {});
    expect(run.realArgs).toBe("--continue  -z Repeat it");
  });
  it("passes empty --resume values through instead of translating an invalid selector (#5254)", () => {
    const run = runWrapper(["--resume=", "-z", "Repeat it"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--resume= -z Repeat it");
  });

  it("passes space-form one-shot without a prompt through instead of treating a flag as the prompt (#5254)", () => {
    const run = runWrapper(["-z", "--resume", "20260612_050401_aa9d27"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("-z --resume 20260612_050401_aa9d27");
  });

  it("passes separated --resume with an empty value through instead of translating an invalid selector (#5254)", () => {
    const run = runWrapper(["--resume", "", "-z", "Repeat it"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--resume  -z Repeat it");
  });

  it("passes separated --resume with a flag-like value through instead of translating an invalid selector (#5254)", () => {
    const run = runWrapper(["--resume", "-z", "--oneshot=Repeat it"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--resume -z --oneshot=Repeat it");
  });

  it("passes value flags without required arguments through instead of translating partial argv (#5254)", () => {
    const run = runWrapper(
      ["--model", "--resume", "20260612_050401_aa9d27", "-z", "Repeat it"],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--model --resume 20260612_050401_aa9d27 -z Repeat it");
  });
});
