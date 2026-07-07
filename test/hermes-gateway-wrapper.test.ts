// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the hermes CLI wrapper (agents/hermes/hermes-wrapper.py), which
// closes the #4975 bypass: `docker exec ... hermes gateway run` must enforce the
// same runtime-env secret boundary as the nemoclaw-start entrypoint, refusing
// raw secret-shaped env vars and never reaching the real gateway.
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

import { buildHermesConfig } from "../agents/hermes/config/hermes-config.ts";
import { buildOpenshellExecArgs } from "../src/lib/actions/sandbox/exec.ts";

const WRAPPER = path.join(import.meta.dirname, "..", "agents", "hermes", "hermes-wrapper.py");
const VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);

function python3Available(): boolean {
  try {
    return spawnSync("python3", ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
const canRun = process.platform === "linux" && python3Available();

type WrapperRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  realInvoked: boolean;
  realArgs: string;
  realArgv: string[];
};

type StubBehaviour = { stdout?: string; stderr?: string; exitCode?: number };

function runWrapper(
  args: string[],
  env: Record<string, string>,
  opts: {
    shadowPython?: boolean;
    shadowHelpers?: Record<string, string>;
    stub?: StubBehaviour;
    stubMode?: number;
    validatorScript?: string;
  } = {},
): WrapperRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-"));
  try {
    fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
    const validatorContent = opts.validatorScript ?? fs.readFileSync(VALIDATOR, "utf-8");
    // Source-layout filename lets the wrapper's dev fallback pick it up.
    fs.writeFileSync(path.join(dir, "validate-env-secret-boundary.py"), validatorContent, {
      mode: 0o755,
    });
    fs.chmodSync(path.join(dir, "hermes"), 0o755);

    const marker = path.join(dir, "real-invoked.txt");
    const stubStdout = opts.stub?.stdout ?? "";
    const stubStderr = opts.stub?.stderr ?? "";
    const stubExit = opts.stub?.exitCode ?? 0;
    const stubScript = [
      "#!/usr/bin/env bash",
      `node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(marker)} "$@"`,
      stubStdout ? `cat <<'__NEMOCLAW_STUB_EOF__'\n${stubStdout}\n__NEMOCLAW_STUB_EOF__` : "",
      stubStderr
        ? `cat <<'__NEMOCLAW_STUB_ERR_EOF__' >&2\n${stubStderr}\n__NEMOCLAW_STUB_ERR_EOF__`
        : "",
      `exit ${stubExit}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: opts.stubMode ?? 0o755 });

    // Plant malicious helpers earlier on PATH; the wrapper must ignore them.
    const planted: Record<string, string> = {
      ...(opts.shadowHelpers ?? {}),
      ...(opts.shadowPython ? { python3: "#!/usr/bin/env bash\nexit 0\n" } : {}),
    };
    let pathPrefix = "";
    if (Object.keys(planted).length > 0) {
      const evilBin = path.join(dir, "evil-bin");
      fs.mkdirSync(evilBin);
      for (const [name, script] of Object.entries(planted)) {
        fs.writeFileSync(path.join(evilBin, name), script, { mode: 0o755 });
      }
      pathPrefix = `${evilBin}${path.delimiter}`;
    }

    const result = spawnSync(path.join(dir, "hermes"), args, {
      encoding: "utf-8",
      timeout: 10000,
      env: { PATH: `${pathPrefix}${process.env.PATH ?? ""}`, HOME: dir, ...env },
    });

    const realInvoked = fs.existsSync(marker);
    const realArgv = realInvoked ? JSON.parse(fs.readFileSync(marker, "utf-8")) : [];
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      realInvoked,
      realArgs: realArgv.join(" "),
      realArgv,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.py", () => {
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

  it("refuses `gateway` with a raw secret-shaped env var and never starts the gateway (#4975)", () => {
    const run = runWrapper(["gateway", "run"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[SECURITY]");
    expect(run.stderr).toContain("process environment");
    expect(run.stderr).toContain("SLACK_BOT_TOKEN");
    expect(run.stderr).not.toContain("xoxb-real-1234567890");
    expect(run.realInvoked).toBe(false);
  });

  it("cannot be bypassed by shadowing python3 on PATH after review (#4981)", () => {
    // PATH is part of the untrusted env; a planted python3 that exits 0 must not
    // let the gateway start with a raw secret. The wrapper uses a trusted
    // absolute interpreter, so the guard still refuses.
    const run = runWrapper(
      ["gateway", "run"],
      { SLACK_BOT_TOKEN: "xoxb-real-1234567890" },
      { shadowPython: true },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[SECURITY]");
    expect(run.realInvoked).toBe(false);
  });

  it("allows `gateway` when only resolver placeholders / allow-listed keys are present", () => {
    const run = runWrapper(["gateway", "run"], {
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      OPENCLAW_GATEWAY_TOKEN: "raw-gateway-token",
      OPENSHELL_TLS_CA: "/etc/openshell/tls/client/ca.crt",
      OPENSHELL_TLS_CERT: "/etc/openshell/tls/client/tls.crt",
      OPENSHELL_TLS_KEY: "/etc/openshell/tls/client/tls.key",
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("gateway run");
  });

  it("refuses `gateway` with a noncanonical OpenShell TLS key path", () => {
    const value = "/tmp/not-openshell/tls.key";
    const run = runWrapper(["gateway", "run"], { OPENSHELL_TLS_KEY: value });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("process environment");
    expect(run.stderr).toContain("OPENSHELL_TLS_KEY");
    expect(run.stderr).not.toContain(value);
    expect(run.realInvoked).toBe(false);
  });

  it("passes non-gateway subcommands straight through, even with raw secrets present", () => {
    // The guard scopes to gateway startup; other subcommands must not be blocked.
    const run = runWrapper(["dashboard"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("dashboard");
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

  it("keeps translated resumed one-shot turns on the same fake session and reports exec failures (#5254)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-session-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      const statePath = path.join(dir, "sessions.json");
      fs.writeFileSync(
        path.join(dir, "hermes.real"),
        [
          "#!/usr/bin/env bash",
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
          env: { PATH: process.env.PATH ?? "", HOME: dir, NEMOCLAW_FAKE_SESSIONS: statePath },
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

  it("passes --continue without a value through instead of translating a bare selector (#5254)", () => {
    const run = runWrapper(["--continue", "-z", "Repeat it"], {});

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--continue -z Repeat it");
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

  it("passes --version through (build assertion path) without invoking the guard", () => {
    const run = runWrapper(["--version"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(0);
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--version");
  });

  it("invokes the runtime-env validator with python3 -I (isolated mode)", () => {
    // Redirect `_TRUSTED_PYTHON3` at a stub python3 that records its argv, so
    // a regression that drops `-I` from the runtime-env invocation fails via
    // real exec rather than source inspection. `-I` matters because it
    // disables PYTHONPATH / PYTHONHOME / user-site startup hooks that a
    // hostile runtime environment could otherwise use to load attacker-
    // controlled code before the validator runs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-argv-"));
    try {
      const argvLog = path.join(dir, "argv.log");
      const stubPython = path.join(dir, "trusted-python3");
      fs.writeFileSync(
        stubPython,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexit 1\n`,
        { mode: 0o755 },
      );
      const wrapperSrc = fs
        .readFileSync(WRAPPER, "utf-8")
        .replace(
          /_TRUSTED_PYTHON3 = \([\s\S]*?\)/,
          `_TRUSTED_PYTHON3 = (${JSON.stringify(stubPython)},)`,
        );
      fs.writeFileSync(path.join(dir, "hermes"), wrapperSrc, { mode: 0o755 });
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.writeFileSync(path.join(dir, "hermes.real"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      const run = spawnSync(path.join(dir, "hermes"), ["gateway", "run"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });
      expect(run.status).not.toBe(0);
      const argv = fs.readFileSync(argvLog, "utf-8").trim().split("\n");
      expect(argv[0]).toBe("-I");
      expect(argv[argv.length - 1]).toBe("runtime-env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invokes the config-show masker with python3 -I (isolated mode)", () => {
    // Same behavioural check for `mask-config-output`. Two maskers spawn (one
    // per Hermes stream) so the log captures the first one's argv; that is
    // sufficient to prove `-I` reached the argv construction.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-argv-mask-"));
    try {
      const argvLog = path.join(dir, "argv.log");
      const stubPython = path.join(dir, "trusted-python3");
      fs.writeFileSync(
        stubPython,
        [
          "#!/usr/bin/env bash",
          `[ -e ${JSON.stringify(argvLog)} ] || printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const wrapperSrc = fs
        .readFileSync(WRAPPER, "utf-8")
        .replace(
          /_TRUSTED_PYTHON3 = \([\s\S]*?\)/,
          `_TRUSTED_PYTHON3 = (${JSON.stringify(stubPython)},)`,
        );
      fs.writeFileSync(path.join(dir, "hermes"), wrapperSrc, { mode: 0o755 });
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.writeFileSync(path.join(dir, "hermes.real"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      const run = spawnSync(path.join(dir, "hermes"), ["config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });
      expect(run.status).not.toBe(0);
      const argv = fs.readFileSync(argvLog, "utf-8").trim().split("\n");
      expect(argv[0]).toBe("-I");
      expect(argv[argv.length - 1]).toBe("mask-config-output");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses gateway and config show with exit 127 when no trusted python3 interpreter exists", () => {
    // `_resolve_trusted_python3()` scans a fixed absolute-path list; when
    // every candidate is missing, `_run_gateway_guard()` and
    // `_run_config_show()` must exit 127 with a `[SECURITY]` message rather
    // than fall back to a PATH-resolved python3. Rewrite the tuple to point
    // at paths guaranteed not to exist, run both entrypoints, and assert
    // the fail-closed contract stays intact.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-no-python-"));
    try {
      const missingA = path.join(dir, "missing-python3-a");
      const missingB = path.join(dir, "missing-python3-b");
      const missingC = path.join(dir, "missing-python3-c");
      const wrapperSrc = fs
        .readFileSync(WRAPPER, "utf-8")
        .replace(
          /_TRUSTED_PYTHON3 = \([\s\S]*?\)/,
          `_TRUSTED_PYTHON3 = (${JSON.stringify(missingA)}, ${JSON.stringify(missingB)}, ${JSON.stringify(missingC)})`,
        );
      fs.writeFileSync(path.join(dir, "hermes"), wrapperSrc, { mode: 0o755 });
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.writeFileSync(path.join(dir, "hermes.real"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const gatewayRun = spawnSync(path.join(dir, "hermes"), ["gateway", "run"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir, SLACK_BOT_TOKEN: "" },
      });
      expect(gatewayRun.status).toBe(127);
      expect(gatewayRun.stderr).toContain("[SECURITY]");
      expect(gatewayRun.stderr).toContain("no python3 at a trusted absolute path");

      const configRun = spawnSync(path.join(dir, "hermes"), ["config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });
      expect(configRun.status).toBe(127);
      expect(configRun.stderr).toContain("[SECURITY]");
      expect(configRun.stderr).toContain("no python3 at a trusted absolute path");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks api_key values in `config show` Python dict output", () => {
    const fixture = [
      "◆ Model",
      "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
      "                 'base_url': 'https://inference.local/v1',",
      "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      "  Max turns:    60",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("config show");
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain("'default': 'meta/llama-3.1-8b-instruct'");
    expect(run.stdout).toContain("'base_url': 'https://inference.local/v1'");
    expect(run.stdout).toContain("Max turns:    60");
  });

  it("masks api_key values in `config show` JSON and YAML output", () => {
    const fixture = [
      '{"providers": {"nemoclaw-inference": {"api_key": "sk-OPENSHELL-PROXY-REWRITE"}}}',
      "providers:",
      "  nemoclaw-inference:",
      "    api_key: sk-OPENSHELL-PROXY-REWRITE",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain('"api_key": "sk-****"');
    expect(run.stdout).toContain("api_key: sk-****");
  });

  it("propagates the real binary's non-zero exit through the `config show` pipe", () => {
    const run = runWrapper(
      ["config", "show"],
      {},
      { stub: { stdout: "api_key: sk-fake-value", exitCode: 7 } },
    );

    expect(run.status).toBe(7);
    expect(run.stdout).toContain("api_key: sk-****");
  });

  it("fails closed without a traceback when config show cannot exec Hermes", () => {
    const run = runWrapper(["config", "show"], {}, { stubMode: 0o644 });
    expect(run.status).toBe(126);
    expect(run.stderr).toContain("[SECURITY] Refusing hermes config show: failed to exec Hermes");
    expect(run.stderr).not.toContain("Traceback");
    expect(run.realInvoked).toBe(false);
  });

  it("leaves non-`config show` output untouched even when api_key shapes appear", () => {
    const fixture = "providers:\n  nemoclaw-inference:\n    api_key: sk-OPENSHELL-PROXY-REWRITE";
    const run = runWrapper(["config", "list"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("masks non-sk- value shapes (nvapi-, plain) on api_key fields", () => {
    const fixture = [
      "{'api_key': 'nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'}",
      '{"api_key": "raw-secret-no-prefix-value"}',
      "api_key: nvapi-zzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(run.stdout).not.toContain("nvapi-zzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    expect(run.stdout).not.toContain("raw-secret-no-prefix-value");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain('"api_key": "sk-****"');
    expect(run.stdout).toContain("api_key: sk-****");
  });

  it("masks other secret-shaped fields beyond api_key (access_token, secret, password, token)", () => {
    const fixture = [
      "{'access_token': 'leaked-access-token-12345', 'secret_key': 'leaked-secret-key-12345'}",
      '{"client_secret": "leaked-client-secret-12345"}',
      "token: leaked-bearer-token-12345",
      "password: leaked-password-12345",
      "bearer: leaked-bearer-12345",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-access-token-12345");
    expect(run.stdout).not.toContain("leaked-secret-key-12345");
    expect(run.stdout).not.toContain("leaked-client-secret-12345");
    expect(run.stdout).not.toContain("leaked-bearer-token-12345");
    expect(run.stdout).not.toContain("leaked-password-12345");
    expect(run.stdout).not.toContain("leaked-bearer-12345");
    expect(run.stdout).toContain("'access_token': 'sk-****'");
    expect(run.stdout).toContain("'secret_key': 'sk-****'");
    expect(run.stdout).toContain('"client_secret": "sk-****"');
    expect(run.stdout).toContain("token: sk-****");
    expect(run.stdout).toContain("password: sk-****");
    expect(run.stdout).toContain("bearer: sk-****");
  });

  it("leaves non-secret fields untouched when their values do not match a secret token shape", () => {
    const fixture = [
      "{'provider': 'custom-inference'}",
      '{"base_url": "https://api.example.com/v1/chat"}',
      "default: meta/llama-3.1-8b-instruct",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("custom-inference");
    expect(run.stdout).toContain("https://api.example.com/v1/chat");
    expect(run.stdout).toContain("default: meta/llama-3.1-8b-instruct");
  });

  it("masks hyphenated quoted secret-key fields (api-key, access-token)", () => {
    const fixture = [
      "{'api-key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      '{"access-token": "leaked-access-token-12345"}',
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).not.toContain("leaked-access-token-12345");
    expect(run.stdout).toContain("'api-key': 'sk-****'");
    expect(run.stdout).toContain('"access-token": "sk-****"');
  });

  it("masks credential-shaped values that hermes emits on stderr", () => {
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: "api_key: ok",
          stderr: "api_key: sk-stderr-leaked-secret-12345",
          exitCode: 0,
        },
      },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("sk-stderr-leaked-secret-12345");
    expect(run.stderr).toContain("api_key: sk-****");
  });

  it("fails closed when the stderr masker exits non-zero while hermes writes credential-shaped diagnostics", () => {
    const stderrOnlyFailValidator = [
      "#!/usr/bin/env python3",
      "import sys",
      "data = sys.stdin.read()",
      'if "FAIL-MARKER" in data:',
      '    sys.stderr.write("stderr masker boom\\n")',
      "    sys.exit(3)",
      "sys.stdout.write(data)",
      "",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: "api_key: ok",
          stderr: "FAIL-MARKER api_key: sk-stderr-only-leak-12345",
          exitCode: 0,
        },
        validatorScript: stderrOnlyFailValidator,
      },
    );

    expect(run.status).toBe(3);
    expect(run.stderr).toContain("output masker failed (stderr)");
    expect(run.stderr).not.toContain("sk-stderr-only-leak-12345");
  });

  it("masks camelCase variants (apiKey, accessToken, clientSecret, authToken)", () => {
    const fixture = [
      "{'apiKey': 'leaked-camel-api-12345', 'accessToken': 'leaked-camel-access-12345'}",
      '{"clientSecret": "leaked-camel-client-12345"}',
      "authToken: leaked-camel-auth-12345",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-camel-api-12345");
    expect(run.stdout).not.toContain("leaked-camel-access-12345");
    expect(run.stdout).not.toContain("leaked-camel-client-12345");
    expect(run.stdout).not.toContain("leaked-camel-auth-12345");
    expect(run.stdout).toContain("'apiKey': 'sk-****'");
    expect(run.stdout).toContain("'accessToken': 'sk-****'");
    expect(run.stdout).toContain('"clientSecret": "sk-****"');
    expect(run.stdout).toContain("authToken: sk-****");
  });

  it("masks plural secret-field variants (api_keys, secrets, tokens) in config show output", () => {
    const fixture = [
      "{'api_keys': 'leaked-plural-keys-12345', 'secrets': 'leaked-plural-secrets-12345'}",
      '{"tokens": "leaked-plural-tokens-12345"}',
      "passwords: leaked-plural-passwords-12345",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-plural-keys-12345");
    expect(run.stdout).not.toContain("leaked-plural-secrets-12345");
    expect(run.stdout).not.toContain("leaked-plural-tokens-12345");
    expect(run.stdout).not.toContain("leaked-plural-passwords-12345");
    expect(run.stdout).toContain("'api_keys': 'sk-****'");
    expect(run.stdout).toContain("'secrets': 'sk-****'");
    expect(run.stdout).toContain('"tokens": "sk-****"');
    expect(run.stdout).toContain("passwords: sk-****");
  });

  it("masks YAML block-scalar headers with indentation and chomping indicators", () => {
    const fixture = [
      "token: |2",
      "    leaked-yaml-indent-12345",
      "api_key: |2-",
      "    leaked-yaml-indent-trail-12345",
      "access_token: |-2",
      "    leaked-yaml-trail-indent-12345",
      "auth_token: >2",
      "    leaked-yaml-folded-indent-12345",
      "client_secret: >5+",
      "     leaked-yaml-folded-12345",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-yaml-indent-12345");
    expect(run.stdout).not.toContain("leaked-yaml-indent-trail-12345");
    expect(run.stdout).not.toContain("leaked-yaml-trail-indent-12345");
    expect(run.stdout).not.toContain("leaked-yaml-folded-indent-12345");
    expect(run.stdout).not.toContain("leaked-yaml-folded-12345");
    expect(run.stdout).toContain("sk-****");
  });

  it("fails closed when the config masker succeeds with oversized stderr", () => {
    const validatorScript = [
      "#!/usr/bin/env python3",
      "import sys",
      "sys.stderr.write('x' * (11 * 1024 * 1024))",
      "raise SystemExit(0)",
      "",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { validatorScript });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("output masker stderr exceeded");
    expect(run.stderr).not.toContain("xxxxxxxxxxxxxxxx");
  });

  it("fails closed with a stable error when config show stdout exceeds the 4 MiB masker cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-oversize-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.chmodSync(path.join(dir, "validate-env-secret-boundary.py"), 0o755);
      const stubScript = [
        "#!/usr/bin/env python3",
        "import sys",
        "for _ in range(70):",
        '    sys.stdout.write("x" * 65536 + "\\n")',
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });
      const result = spawnSync(path.join(dir, "hermes"), ["config", "show"], {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("masker input exceeded");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when masker stdin is not valid UTF-8 instead of leaking a Python traceback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-utf8-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.chmodSync(path.join(dir, "validate-env-secret-boundary.py"), 0o755);
      const stubScript = [
        "#!/usr/bin/env python3",
        "import sys",
        'sys.stdout.buffer.write(b"api_key: \\xff\\xfeleaked-invalid-utf8-12345\\n")',
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });
      const result = spawnSync(path.join(dir, "hermes"), ["config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("leaked-invalid-utf8-12345");
      expect(result.stderr).toContain("not valid UTF-8");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completes a 100 KB unquoted value line in well under a second (ReDoS guard)", () => {
    const huge = `key: ${"a".repeat(100 * 1024)}`;
    const start = Date.now();
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: huge, exitCode: 0 } });
    const elapsed = Date.now() - start;

    expect(run.status).toBe(0);
    expect(elapsed).toBeLessThan(2000);
  });

  it("masks api_secret and auth_token fields beyond the explicit api_key/access_token shapes", () => {
    const fixture = [
      "{'api_secret': 'leaked-api-secret-12345', 'auth_token': 'leaked-auth-token-12345'}",
      '{"api_secret": "leaked-api-secret-67890"}',
      "auth_token: leaked-auth-token-67890",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-api-secret-12345");
    expect(run.stdout).not.toContain("leaked-auth-token-12345");
    expect(run.stdout).not.toContain("leaked-api-secret-67890");
    expect(run.stdout).not.toContain("leaked-auth-token-67890");
    expect(run.stdout).toContain("'api_secret': 'sk-****'");
    expect(run.stdout).toContain("'auth_token': 'sk-****'");
    expect(run.stdout).toContain('"api_secret": "sk-****"');
    expect(run.stdout).toContain("auth_token: sk-****");
  });

  it("masks every api_key emitted by the generated Hermes config (model, providers, custom_providers) on combined stdout and stderr", () => {
    const fixture = [
      "◆ Model",
      "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
      "                 'base_url': 'https://inference.local/v1',",
      "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      "  Providers:    {'nemoclaw-inference': {'name': 'nemoclaw-inference',",
      "                  'api': 'https://inference.local/v1',",
      "                  'api_key': 'sk-OPENSHELL-PROXY-REWRITE',",
      "                  'default_model': 'meta/llama-3.1-8b-instruct',",
      "                  'discover_models': True}}",
      "  Custom providers: [{'name': 'nemoclaw-inference',",
      "                  'base_url': 'https://inference.local/v1',",
      "                  'api_key': 'sk-OPENSHELL-PROXY-REWRITE',",
      "                  'discover_models': True}]",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: fixture,
          stderr: "api_key: sk-OPENSHELL-PROXY-REWRITE",
          exitCode: 0,
        },
      },
    );

    expect(run.status).toBe(0);
    const combined = `${run.stdout}\n${run.stderr}`;
    expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain("'default': 'meta/llama-3.1-8b-instruct'");
    expect(run.stdout).toContain("'base_url': 'https://inference.local/v1'");
    expect(run.stdout).toContain("'discover_models': True");
    expect(run.stderr).toContain("api_key: sk-****");
  });

  it("fails closed when the masker exits non-zero even though hermes succeeded", () => {
    const failingValidator = [
      "#!/usr/bin/env python3",
      "import sys",
      'sys.stderr.write("masker boom\\n")',
      "sys.exit(2)",
      "",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: { stdout: "api_key: sk-OPENSHELL-PROXY-REWRITE", exitCode: 0 },
        validatorScript: failingValidator,
      },
    );

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("output masker failed");
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("suppresses Python tracebacks from the masker's stderr instead of leaking them to the user", () => {
    const crashingValidator = [
      "#!/usr/bin/env python3",
      "import sys",
      'sys.stderr.write("Traceback (most recent call last):\\n")',
      "sys.stderr.write('  File \"/internal/secret-boundary.py\", line 42\\n')",
      'sys.stderr.write("ValueError: hermes wrapper internal path leak\\n")',
      "sys.exit(2)",
      "",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: { stdout: "api_key: sk-OPENSHELL-PROXY-REWRITE", exitCode: 0 },
        validatorScript: crashingValidator,
      },
    );

    expect(run.status).toBe(2);
    expect(run.stderr).not.toContain("Traceback");
    expect(run.stderr).not.toContain("/internal/secret-boundary.py");
    expect(run.stderr).not.toContain("ValueError");
    expect(run.stderr).toContain("output masker failed");
  });

  it("masks YAML block-scalar secrets across continuation lines", () => {
    const fixture = [
      "providers:",
      "  nemoclaw-inference:",
      "    api_key: |",
      "      sk-OPENSHELL-PROXY-REWRITE",
      "      additional-secret-line",
      "    base_url: https://inference.local/v1",
      "  fallback:",
      "    secret: >",
      "      multi",
      "      line",
      "      bearer-token",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).not.toContain("additional-secret-line");
    expect(run.stdout).not.toContain("bearer-token");
    expect(run.stdout).toContain("api_key: |");
    expect(run.stdout).toContain("secret: >");
    expect(run.stdout).toContain("base_url: https://inference.local/v1");
  });

  it("masks quoted secrets even when values contain escaped delimiters", () => {
    const fixture = [
      "{'api_key': 'sk-leak\\'ed-secret-12345'}",
      '{"api_key": "sk-quoted\\"leak-secret-12345"}',
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-leak\\'ed-secret-12345");
    expect(run.stdout).not.toContain('sk-quoted\\"leak-secret-12345');
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain('"api_key": "sk-****"');
  });

  it("preserves inline trailing comments on YAML secret lines", () => {
    const fixture = "api_key: sk-OPENSHELL-PROXY-REWRITE  # routed via OpenShell";
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("api_key: sk-****");
    expect(run.stdout).toContain("# routed via OpenShell");
  });

  it("does not mask api_key mentions inside YAML comments", () => {
    const fixture = [
      "# example: api_key: leave-this-alone-in-comment",
      "api_key: sk-OPENSHELL-PROXY-REWRITE",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("# example: api_key: leave-this-alone-in-comment");
    expect(run.stdout).toContain("api_key: sk-****");
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("ignores PATH-shadowed external helpers so the stderr buffer cannot be redirected to an attacker path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-pathshadow-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      const stubScript = [
        "#!/usr/bin/env bash",
        "printf 'ok: 1\\n'",
        "printf 'api_key: sk-PATH-SHADOW-STDERR-LEAK-12345\\n' >&2",
        "exit 0",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });
      const evilBin = path.join(dir, "evil-bin");
      fs.mkdirSync(evilBin);
      const evilMktempLeak = path.join(dir, "evil-mktemp-leak.txt");
      const evilRmMarker = path.join(dir, "evil-rm-called.txt");
      const evilDirnameMarker = path.join(dir, "evil-dirname-called.txt");
      const writeEvil = (name: string, body: string) =>
        fs.writeFileSync(path.join(evilBin, name), body, { mode: 0o755 });
      writeEvil(
        "mktemp",
        [
          "#!/usr/bin/env bash",
          `out=${JSON.stringify(evilMktempLeak)}`,
          ': > "$out"',
          'echo "$out"',
          "",
        ].join("\n"),
      );
      writeEvil(
        "rm",
        [
          "#!/usr/bin/env bash",
          `printf 'evil-rm called with %s\\n' "$*" > ${JSON.stringify(evilRmMarker)}`,
          "",
        ].join("\n"),
      );
      writeEvil(
        "dirname",
        [
          "#!/usr/bin/env bash",
          `printf 'evil-dirname called with %s\\n' "$*" > ${JSON.stringify(evilDirnameMarker)}`,
          'echo "/evil/path"',
          "",
        ].join("\n"),
      );

      const result = spawnSync(path.join(dir, "hermes"), ["config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: `${evilBin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: dir },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("sk-PATH-SHADOW-STDERR-LEAK-12345");
      expect(result.stderr).toContain("api_key: sk-****");
      expect(fs.existsSync(evilMktempLeak)).toBe(false);
      expect(fs.existsSync(evilRmMarker)).toBe(false);
      expect(fs.existsSync(evilDirnameMarker)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not crash on malformed input and still masks recognised secret fields", () => {
    const fixture = [
      "}}}}{{{{ bogus prefix line",
      'api_key: "unclosed quote then garbage rest',
      "api_key: sk-real-after-bogus-12345",
      "garbage line with no colons at all",
      "api_key: |",
      "  sk-real-block-leak-12345",
      "  more secret block content",
      "next: not-a-secret-value",
      "{garbage} { nested stuff } { api_key: should-not-match",
      "api_key:   sk-real-trailing-spaces-12345   ",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-real-after-bogus-12345");
    expect(run.stdout).not.toContain("sk-real-block-leak-12345");
    expect(run.stdout).not.toContain("more secret block content");
    expect(run.stdout).not.toContain("sk-real-trailing-spaces-12345");
    expect(run.stdout).toContain("api_key: sk-****");
    expect(run.stdout).toContain("garbage line with no colons at all");
    expect(run.stdout).toContain("next: not-a-secret-value");
  });

  it("masks `config show` output when the wrapper is exec'd via its absolute shebang under a hostile BASH_ENV", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-shebang-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      const bashEnvScript = path.join(dir, "bash-env-evil.sh");
      const bashEnvMarker = path.join(dir, "bash-env-evil-marker.txt");
      fs.writeFileSync(
        bashEnvScript,
        [
          "#!/bin/bash",
          `printf 'evil-bash-env executed\\n' > ${JSON.stringify(bashEnvMarker)}`,
          // Try to subvert the masker by exporting a malicious PYTHON3 override
          // and predefining the helper as a no-op. The wrapper resolves its
          // helpers from absolute paths and uses `local`/`PYTHON3=$(...)`, so
          // these overrides must not survive into the masking pipeline.
          "PYTHON3=/usr/bin/true",
          "_resolve_trusted_python3() { echo /usr/bin/true; }",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const stubScript = [
        "#!/bin/bash",
        "printf 'api_key: sk-SHEBANG-PATH-LEAK-12345\\n'",
        "exit 0",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });

      const result = spawnSync(path.join(dir, "hermes"), ["config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          BASH_ENV: bashEnvScript,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("sk-SHEBANG-PATH-LEAK-12345");
      expect(result.stdout).toContain("api_key: sk-****");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("composes the openshell dispatch argv built by buildOpenshellExecArgs with the wrapper so `nemoclaw <name> exec -- hermes config show` masks Model api_key (#5981)", () => {
    const dispatchArgv = buildOpenshellExecArgs("hermes-sandbox", ["hermes", "config", "show"]);
    expect(dispatchArgv).toEqual([
      "sandbox",
      "exec",
      "--name",
      "hermes-sandbox",
      "--",
      "hermes",
      "config",
      "show",
    ]);
    const innerCommand = dispatchArgv.slice(dispatchArgv.indexOf("--") + 1);
    expect(innerCommand).toEqual(["hermes", "config", "show"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-dispatch-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      const fixture = [
        "◆ Model",
        "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
        "                 'base_url': 'https://inference.local/v1',",
        "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      ].join("\n");
      const stubScript = [
        "#!/usr/bin/env bash",
        `cat <<'__NEMOCLAW_STUB_EOF__'\n${fixture}\n__NEMOCLAW_STUB_EOF__`,
        `printf 'api_key: sk-OPENSHELL-PROXY-REWRITE\\n' >&2`,
        "exit 0",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });
      const openshellStubPath = path.join(dir, "openshell");
      fs.writeFileSync(
        openshellStubPath,
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
          "  shift 2",
          '  while [ "$1" != "--" ]; do shift; done',
          "  shift",
          '  shift  # drop the program name (e.g. "hermes") so the wrapper receives only its args',
          `  exec ${JSON.stringify(path.join(dir, "hermes"))} "$@"`,
          "fi",
          "exit 2",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(openshellStubPath, dispatchArgv, {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });

      expect(result.status).toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
      expect(result.stdout).toContain("'api_key': 'sk-****'");
      expect(result.stderr).toContain("api_key: sk-****");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reproduces the public `nemoclaw hermes exec -- hermes config show` dispatch path with masked output (#5981)", () => {
    // `nemoclaw hermes exec -- <argv>` resolves to `openshell sandbox exec
    // --name <sandbox> -- <argv>`, which runs `<argv>` inside the sandbox
    // container with `argv[0]` resolved against the in-sandbox PATH. Inside
    // the Hermes sandbox image (see `agents/hermes/Dockerfile`),
    // `/usr/local/bin/hermes` is the wrapper script tested here; the real
    // binary is at `/usr/local/bin/hermes.real`. The dispatcher adds no
    // masking layer of its own, so invoking the wrapper directly through
    // `bash <wrapper> config show` is behaviourally equivalent to the public
    // command for the masking contract. The fixture mirrors the issue's
    // exact `◆ Model` shape on stdout and an api_key-shaped diagnostic on
    // stderr; both must reach the user masked.
    const fixture = [
      "◆ Model",
      "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
      "                 'base_url': 'https://inference.local/v1',",
      "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: fixture,
          stderr: "api_key: sk-OPENSHELL-PROXY-REWRITE",
          exitCode: 0,
        },
      },
    );

    expect(run.status).toBe(0);
    const combined = `${run.stdout}\n${run.stderr}`;
    expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stderr).toContain("api_key: sk-****");
  });

  it("redacts free-form sk- tokens in prose diagnostics while leaving non-sk token families unscanned", () => {
    const fixture = [
      "Warning: using sk-freeform-leak-12345 for connection",
      "Traceback at line 42 with token bearer-freeform-67890 in stack",
      "Plain prose with no field structure 'sk-prose-only-leak' here",
      "nvapi-no-prefix-token-stays-12345 in diagnostic",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-freeform-leak-12345");
    expect(run.stdout).not.toContain("sk-prose-only-leak");
    expect(run.stdout).toContain("sk-****");
    expect(run.stdout).toContain("bearer-freeform-67890");
    expect(run.stdout).toContain("nvapi-no-prefix-token-stays-12345");
  });

  it("uses the installed-layout paths (/usr/local/bin/hermes.real, /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py) before the dev fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-installed-"));
    try {
      const installBin = path.join(dir, "fake-install/usr/local/bin");
      const installLib = path.join(dir, "fake-install/usr/local/lib/nemoclaw");
      fs.mkdirSync(installBin, { recursive: true });
      fs.mkdirSync(installLib, { recursive: true });
      fs.writeFileSync(
        path.join(installBin, "hermes.real"),
        [
          "#!/usr/bin/env bash",
          "printf 'installed-real-invoked\\n'",
          "printf 'api_key: sk-OPENSHELL-PROXY-REWRITE\\n'",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.copyFileSync(VALIDATOR, path.join(installLib, "validate-hermes-env-secret-boundary.py"));
      const wrapperBody = fs
        .readFileSync(WRAPPER, "utf-8")
        .replace(/\/usr\/local\/bin\/hermes\.real/g, path.join(installBin, "hermes.real"))
        .replace(
          /\/usr\/local\/lib\/nemoclaw\/validate-hermes-env-secret-boundary\.py/g,
          path.join(installLib, "validate-hermes-env-secret-boundary.py"),
        );
      const wrapperPath = path.join(dir, "hermes");
      fs.writeFileSync(wrapperPath, wrapperBody, { mode: 0o755 });
      const decoyDir = path.join(dir, "decoy");
      fs.mkdirSync(decoyDir);
      fs.writeFileSync(
        path.join(decoyDir, "hermes.real"),
        "#!/usr/bin/env bash\nprintf 'decoy-real-invoked\\n'\nexit 99\n",
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(decoyDir, "validate-env-secret-boundary.py"),
        "#!/usr/bin/env python3\nimport sys\nsys.exit(99)\n",
        { mode: 0o755 },
      );
      fs.copyFileSync(wrapperPath, path.join(decoyDir, "hermes"));

      const result = spawnSync(path.join(decoyDir, "hermes"), ["config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("installed-real-invoked");
      expect(result.stdout).not.toContain("decoy-real-invoked");
      expect(result.stdout).toContain("api_key: sk-****");
      expect(result.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks every api_key emitted by buildHermesConfig so the generated config cannot leak through `config show`", () => {
    const settings = {
      model: "meta/llama-3.1-8b-instruct",
      baseUrl: "https://inference.local/v1",
      providerKey: "custom",
      upstreamProvider: "nemoclaw-inference",
      inferenceApi: "",
      toolDisclosure: "progressive" as const,
      webSearchProvider: null,
      messagingCredentialPlaceholders: [],
      managedToolGateways: { brokerEnabled: false, presets: [] },
    };
    const generated = buildHermesConfig(settings);
    const fixture = JSON.stringify(generated, null, 2);
    expect(fixture).toContain("sk-OPENSHELL-PROXY-REWRITE");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain('"api_key": "sk-****"');
    expect(run.stdout).toContain('"default": "meta/llama-3.1-8b-instruct"');
    expect(run.stdout).toContain('"base_url": "https://inference.local/v1"');
  });

  it("masks api_key on the installed `/usr/local/bin/hermes` layout (REAL_HERMES and GUARD resolved from absolute install paths)", () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-install-"));
    try {
      const binDir = path.join(prefix, "usr", "local", "bin");
      const libDir = path.join(prefix, "usr", "local", "lib", "nemoclaw");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(libDir, { recursive: true });
      const installedReal = path.join(binDir, "hermes.real");
      const installedGuard = path.join(libDir, "validate-hermes-env-secret-boundary.py");
      const wrapperContent = fs
        .readFileSync(WRAPPER, "utf-8")
        .replace(
          '_INSTALLED_REAL = "/usr/local/bin/hermes.real"',
          `_INSTALLED_REAL = ${JSON.stringify(installedReal)}`,
        )
        .replace(
          '_INSTALLED_GUARD = "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py"',
          `_INSTALLED_GUARD = ${JSON.stringify(installedGuard)}`,
        );
      const installedWrapper = path.join(binDir, "hermes");
      fs.writeFileSync(installedWrapper, wrapperContent, { mode: 0o755 });
      fs.copyFileSync(VALIDATOR, installedGuard);
      fs.chmodSync(installedGuard, 0o755);

      const settings = {
        model: "meta/llama-3.1-8b-instruct",
        baseUrl: "https://inference.local/v1",
        providerKey: "custom",
        upstreamProvider: "nemoclaw-inference",
        inferenceApi: "",
        toolDisclosure: "progressive" as const,
        webSearchProvider: null,
        messagingCredentialPlaceholders: [],
        managedToolGateways: { brokerEnabled: false, presets: [] },
      };
      const generated = buildHermesConfig(settings);
      const fixture = JSON.stringify(generated, null, 2);
      const stubScript = [
        "#!/usr/bin/env bash",
        `cat <<'__NEMOCLAW_STUB_EOF__'\n${fixture}\n__NEMOCLAW_STUB_EOF__`,
        "exit 0",
        "",
      ].join("\n");
      fs.writeFileSync(installedReal, stubScript, { mode: 0o755 });

      const result = spawnSync(installedWrapper, ["config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: prefix },
      });

      expect(result.status).toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
      expect(result.stdout).toContain('"api_key": "sk-****"');
    } finally {
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });
});
