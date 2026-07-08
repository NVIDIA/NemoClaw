// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const execSandboxMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/lib/actions/sandbox/exec", () => ({
  execSandbox: execSandboxMock,
}));

import SandboxExecCommand from "../../../src/commands/sandbox/exec.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS } from "../live/cloud-experimental-check-list.ts";
import {
  assertRequiredCloudExperimentalResult,
  buildCloudExperimentalChecksEvidence,
  buildCloudExperimentalCommandEnv,
  cloudExperimentalCheckTimeoutMs,
} from "../live/cloud-experimental-checks.ts";

function shellResult(exitCode: number, stdout: string, stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: {
      stdout: "stdout.txt",
      stderr: "stderr.txt",
      result: "result.json",
    },
  };
}

const tclshAvailable =
  spawnSync("tclsh", ["-"], { encoding: "utf8", input: "exit 0\n" }).status === 0;

describe("P0-E cloud-experimental parity guardrails", () => {
  it("preserves the repeated env-unset pairs from the failed observability invocation", async () => {
    await SandboxExecCommand.run(
      [
        "deepagents-sandbox",
        "--",
        "env",
        "-u",
        "ALL_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "HTTP_PROXY",
        "-u",
        "all_proxy",
        "-u",
        "https_proxy",
        "-u",
        "http_proxy",
        "/opt/venv/bin/python3",
        "-I",
        "-c",
        "pass",
      ],
      process.cwd(),
    );

    expect(execSandboxMock).toHaveBeenCalledWith(
      "deepagents-sandbox",
      [
        "env",
        "-u",
        "ALL_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "HTTP_PROXY",
        "-u",
        "all_proxy",
        "-u",
        "https_proxy",
        "-u",
        "http_proxy",
        "/opt/venv/bin/python3",
        "-I",
        "-c",
        "pass",
      ],
      { workdir: undefined, tty: null, timeoutSeconds: undefined },
    );
  });

  it("routes the live OTLP probe through managed Python and the OpenShell proxy", () => {
    const script = fs.readFileSync(
      path.join(
        process.cwd(),
        "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      ),
      "utf8",
    );

    expect(script).toMatch(
      /grep -Fq 'CAPTURE_READY:'[\s\S]*COLLECTOR_PORT}\/health[\s\S]*DECOY_PORT}\/health/,
    );
    expect(script).toContain("urllib.request.urlopen(request, timeout=10)");
    expect(script).toContain("except urllib.error.HTTPError as error:");
    expect(script).toContain('body = error.read(512).decode("utf-8", "replace")');
    expect(script).not.toContain("urllib.request.ProxyHandler({})");
    expect(script).not.toContain("os.environ.pop");
    expect(script).toMatch(/\"\$CLI\" \"\$SANDBOX_NAME\" exec -- \\\n\s+\/opt\/venv\/bin\/python3/);
    expect(script).not.toContain("env -u ALL_PROXY");
    expect(script.match(/--noproxy '\*'/g)).toHaveLength(2);
    expect(script).toContain("/usr/bin/curl --fail-with-body -sS");
    expect(script).toMatch(
      /run_deterministic_tool_trace\(\)[\s\S]*"\$CLI" "\$SANDBOX_NAME" exec --[\s\S]*\/opt\/venv\/bin\/python3/,
    );
  });

  it("skips the DCode observability probe before host prerequisites on other agents", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-observability-skip-"));
    try {
      const invocationLog = path.join(tempDir, "openshell-args.txt");
      const openshell = path.join(tempDir, "openshell");
      fs.writeFileSync(
        openshell,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NEMOCLAW_FAKE_OPENSHELL_LOG"\nexit 1\n',
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          path.join(
            process.cwd(),
            "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
          ),
        ],
        {
          encoding: "utf8",
          env: {
            NEMOCLAW_CLI_BIN: path.join(tempDir, "missing-nemoclaw"),
            NEMOCLAW_FAKE_OPENSHELL_LOG: invocationLog,
            PATH: `${tempDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            REPO: path.join(tempDir, "missing-repo"),
            SANDBOX_NAME: "openclaw-sandbox",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "11-deepagents-code-observability: SKIP: sandbox openclaw-sandbox is not a Deep Agents Code sandbox",
      );
      expect(fs.readFileSync(invocationLog, "utf8")).toBe(
        [
          "sandbox",
          "exec",
          "--name",
          "openclaw-sandbox",
          "--",
          "bash",
          "-c",
          "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("fails required Deep Agents cloud-experimental checks when scripts print SKIP", () => {
    expect(() =>
      assertRequiredCloudExperimentalResult(
        "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
        shellResult(0, "05-deepagents-code-landlock-readonly: SKIP: not a Deep Agents sandbox\n"),
      ),
    ).toThrow(/must not skip/);
  });

  it("fails Deep Agents Python egress blocked-host assertions without denial evidence", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: "blocked-no-marker",
          NEMOCLAW_E2E_PYTHON_PROBE_FIXTURE: "OpenShell runtime error without denial marker",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "self-test Python probe for fixture host lacked denial evidence",
    );
  });

  it("keeps Deep Agents Python egress probe command single-line for OpenShell exec", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: "probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("NO_NEWLINE_IN_COMMAND");
  });

  it("keeps Deep Agents secret-boundary probe command single-line for OpenShell exec", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST: "probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NO_NEWLINE_IN_COMMAND");
  });

  it("keeps Deep Agents Tavily opt-in probe command single-line for OpenShell exec", () => {
    const result = spawnSync(
      "bash",
      [
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_TAVILY_SELF_TEST: "probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NO_NEWLINE_IN_COMMAND");
  });

  it("pins the managed DCode thread-auto-approval live acceptance boundary (#6478)", () => {
    const script = fs.readFileSync(
      path.join(
        process.cwd(),
        "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
      ),
      "utf8",
    );

    for (const expected of [
      "/usr/local/share/nemoclaw/dcode-auto-approval",
      "NEMOCLAW_DCODE_AUTO_APPROVAL=thread-opt-in",
      '"$CLI" "$SANDBOX_NAME" rebuild --yes',
      "--dcode-auto-approval thread-opt-in",
      "status.dcodeAutoApprovalMode !== process.env.EXPECTED_MODE",
      "auto-approve for this thread",
      "auto-approval is enabled",
      'submit_text "/clear"',
      "NEMOCLAW_AUTORUN_MANUAL_APPROVAL_RESTORED",
      "06-deepagents-code-python-egress.sh",
      "08-deepagents-code-secret-boundary.sh",
      "log_user 0",
    ]) {
      expect(script).toContain(expected);
    }
    expect(script).toMatch(
      /Round 1:[\s\S]*shell execute[\s\S]*Round 2:[\s\S]*write_file[\s\S]*Round 3:[\s\S]*shell execute[\s\S]*Round 4:[\s\S]*read_file/,
    );
    expect(script).toMatch(
      /run_autorun_tui[\s\S]*assert_autorun_evidence[\s\S]*run_boundary_check "OpenShell network policy boundary"[\s\S]*run_boundary_check "managed credential boundary"/,
    );
    expect(script).not.toContain("log_file -a");
  });

  it("requires the managed exit and denial evidence for default auto-approval", () => {
    const scriptPath = path.join(
      process.cwd(),
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
    );
    const classify = (exitCode: number, fixture: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; printf \'%s\\n\' "$FIXTURE" | is_default_auto_approval_denial "$2"',
          "nemoclaw-dcode-autorun-self-test",
          scriptPath,
          String(exitCode),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, FIXTURE: fixture },
        },
      ).status;

    const denial =
      "NemoClaw manages Deep Agents Code tool approval posture; remove --auto-approve.";
    expect(classify(2, denial)).toBe(0);
    expect(classify(0, denial)).not.toBe(0);
    expect(classify(124, denial)).not.toBe(0);
    expect(classify(2, "upstream dcode failed for an unrelated reason")).not.toBe(0);
  });

  it.runIf(tclshAvailable)(
    "drives the thread opt-in and reset sequence through a finite Expect state machine",
    () => {
      const script = fs.readFileSync(
        path.join(
          process.cwd(),
          "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
        ),
        "utf8",
      );
      const expectProgram = script.match(/expect <<'EXPECT'\n([\s\S]*?)\nEXPECT/)?.[1];
      expect(expectProgram).toBeTruthy();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-autorun-expect-"));
      const markers = path.join(tempDir, "markers.log");
      const trace = path.join(tempDir, "send.hex");
      fs.writeFileSync(markers, "");
      fs.writeFileSync(trace, "");
      const prelude = String.raw`
proc log_user {args} {}
proc spawn {args} {}
proc after {args} {}
proc send {args} {
  binary scan [lindex $args end] H* encoded
  set fh [open $::env(NEMOCLAW_AUTORUN_EXPECT_TRACE) a]
  puts -nonewline $fh $encoded
  close $fh
}
set ::fake_events [list approval warning workflow newThread approval exit]
proc expect {branches} {
  if {[llength $::fake_events] == 0} {
    error "fake Expect event queue exhausted"
  }
  set event [lindex $::fake_events 0]
  set ::fake_events [lrange $::fake_events 1 end]
  switch -- $event {
    approval { set branch_index [lsearch -exact $branches {auto-approve for this thread}] }
    warning { set branch_index [lsearch -exact $branches {auto-approval is enabled}] }
    workflow { set branch_index [lsearch -exact $branches {NEMOCLAW_AUTORUN_COMPLETE}] }
    newThread { set branch_index [lsearch -exact $branches {started new thread:}] }
    exit {
      set branch_index [lsearch -glob $branches {NEMOCLAW_AUTORUN_TUI_EXIT:*}]
      set ::expect_out(1,string) "0"
    }
    default { error "unsupported fake Expect event: $event" }
  }
  if {$branch_index < 0} {
    error "fake Expect event $event has no matching branch"
  }
  uplevel 1 [lindex $branches [expr {$branch_index + 1}]]
}
`;

      try {
        const result = spawnSync("tclsh", ["-"], {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_AUTORUN_EXPECT_MARKERS: markers,
            NEMOCLAW_AUTORUN_EXPECT_TRACE: trace,
            NEMOCLAW_AUTORUN_FIRST_PROMPT: "FIRST",
            NEMOCLAW_AUTORUN_RESET_PROMPT: "RESET",
            NEMOCLAW_AUTORUN_SANDBOX_NAME: "fake-dcode",
            NEMOCLAW_AUTORUN_TUI_TIMEOUT: "5",
          },
          input: `${prelude}\n${expectProgram}\n`,
        });

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fs.readFileSync(markers, "utf8").trim().split("\n")).toEqual([
          "NEMOCLAW_AUTORUN_APPROVAL_MENU",
          "NEMOCLAW_AUTORUN_WARNING",
          "NEMOCLAW_AUTORUN_WORKFLOW_COMPLETE",
          "NEMOCLAW_AUTORUN_NEW_THREAD",
          "NEMOCLAW_AUTORUN_MANUAL_APPROVAL_RESTORED",
          "NEMOCLAW_AUTORUN_TUI_EXIT:0",
        ]);
        expect(Buffer.from(fs.readFileSync(trace, "utf8"), "hex").toString("utf8")).toBe(
          "a/clear\rRESET\rn/quit\r",
        );
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("registers executable Deep Agents cloud-experimental checks", () => {
    expect(DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS).toEqual([
      "test/e2e/e2e-cloud-experimental/checks/03-deepagents-code-nemotron-ultra-profile.sh",
      "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh",
      "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
      "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
      "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
    ]);

    for (const scriptPath of DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS) {
      const mode = fs.statSync(path.join(process.cwd(), scriptPath)).mode;
      expect(mode & 0o111, `${scriptPath} must be executable`).not.toBe(0);
    }
  });

  it("checks the stock Nemotron Ultra profile before destructive re-onboarding", () => {
    const profileCheckPath = DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS[0];
    const profileCheck = fs.readFileSync(path.join(process.cwd(), profileCheckPath), "utf8");

    expect(profileCheckPath).toBe(
      "test/e2e/e2e-cloud-experimental/checks/03-deepagents-code-nemotron-ultra-profile.sh",
    );
    expect(profileCheck).toContain("/opt/venv/bin/python3 -I -");
    expect(profileCheck).toContain("from langchain_openai import ChatOpenAI");
    expect(profileCheck).toContain("_harness_profile_for_model(make_model(model_id), None)");
    expect(profileCheck).toContain('"nvidia/nemotron-3-ultra-550b-a55b"');
    expect(profileCheck).toContain('"nvidia/nvidia/nemotron-3-ultra"');
    expect(profileCheck).toContain('"deepagents-code": "0.1.34"');
    expect(profileCheck).toContain('"deepagents": "0.7.0a6"');
    expect(profileCheck).toContain("_nvidia_nemotron_3_ultra.__file__");
    expect(profileCheck).toContain('description_overrides["read_file"]');
    expect(profileCheck).toContain("middleware_names(profile) == EXPECTED_MIDDLEWARE");
    expect(profileCheck).toContain('make_model("gpt-4.1-mini")');
    expect(profileCheck).not.toMatch(/\.(?:invoke|ainvoke|stream|astream)\(/);
  });

  it("gives the destructive fresh re-onboard check its onboarding budget", () => {
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
      ),
    ).toBe(15 * 60_000);
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      ),
    ).toBe(180_000);
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      ),
    ).toBe(8 * 60_000);
    expect(
      cloudExperimentalCheckTimeoutMs(
        "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
      ),
    ).toBe(35 * 60_000);
  });

  it("documents Deep Agents check scripts in generated launch/QA evidence", () => {
    const evidence = buildCloudExperimentalChecksEvidence(
      "cloud-langchain-deepagents-code",
      "deepagents-sandbox",
      DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS,
    );

    expect(evidence).toMatchObject({
      targetId: "cloud-langchain-deepagents-code",
      sandboxName: "deepagents-sandbox",
    });
    expect(evidence.checkScripts).toContain(
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
    );
    expect(evidence.terminalConnectHint).toEqual({
      agent: "langchain-deepagents-code",
      interactiveCommand: "dcode",
      statusLine: "Interactive: dcode",
      source: "agents/langchain-deepagents-code/manifest.yaml:runtime.interactive_command",
    });
  });

  it("builds a minimal cloud-experimental child environment", () => {
    const env = buildCloudExperimentalCommandEnv("deepagents-sandbox", "secret-key", {
      HOME: "/home/runner",
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "do-not-copy",
      GITHUB_TOKEN: "do-not-copy",
      NEMOCLAW_MODEL: "model-a",
      RANDOM_RUNNER_SECRET: "do-not-copy",
    });

    expect(env).toMatchObject({
      COMPATIBLE_API_KEY: "secret-key",
      CLOUD_EXPERIMENTAL_MODEL: "model-a",
      NEMOCLAW_SANDBOX_NAME: "deepagents-sandbox",
      SANDBOX_NAME: "deepagents-sandbox",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.RANDOM_RUNNER_SECRET).toBeUndefined();
  });
});
