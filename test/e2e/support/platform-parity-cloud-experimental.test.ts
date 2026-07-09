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

const dcodeTavilyCheck = path.join(
  process.cwd(),
  "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
);
const dcodeFreshReonboardCheck = path.join(
  process.cwd(),
  "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
);

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

describe("P0-E cloud-experimental parity guardrails", () => {
  it("skips the destructive fresh re-onboard check outside a Deep Agents sandbox", () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
    try {
      fs.writeFileSync(path.join(binDir, "openshell"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const result = spawnSync("bash", [dcodeFreshReonboardCheck], {
        encoding: "utf8",
        env: {
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          SANDBOX_NAME: "openclaw-sandbox",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "04-deepagents-code-fresh-reonboard: SKIP: sandbox openclaw-sandbox is not a Deep Agents Code sandbox",
      );
    } finally {
      fs.rmSync(binDir, { force: true, recursive: true });
    }
  });

  it("keeps live DCode config inspection and mutation-boundary coverage in the fresh re-onboard check", () => {
    const script = fs.readFileSync(dcodeFreshReonboardCheck, "utf8");

    expect(script).toContain('"$CLI" "$SANDBOX_NAME" config get');
    expect(script).toContain("config get --key models.default");
    expect(script).toContain("config get --format yaml");
    expect(script).toContain("config set --key models.default");
    expect(script).toContain("sha256sum /sandbox/.deepagents/config.toml");
    expect(script).toContain("config is baked into the sandbox image at build time");
    expect(script).toContain("re-onboard with the new selection");
  });

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

  it("keeps Deep Agents Python egress probe commands single-line for OpenShell exec", () => {
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
    const commands = result.stdout.trim().split("\n");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/^SINGLE_LINE_COMMAND:python3 -c /);
    expect(commands[1]).toMatch(
      /^SINGLE_LINE_COMMAND:\/usr\/local\/lib\/nemoclaw\/dcode-managed-exec \/opt\/venv\/bin\/python3 -c /,
    );
  });

  it("keeps Deep Agents fetch_url probe command single-line for OpenShell exec", () => {
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
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: "fetch-probe-command-shape",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("NO_NEWLINE_IN_FETCH_COMMAND");
  });

  it.each([
    [
      "accepts an explicit non-empty success response",
      "fetch-success-classification",
      "FETCH_SUCCESS:200:1234",
      0,
      "1 passed",
    ],
    [
      "accepts explicit denial evidence",
      "fetch-blocked-classification",
      "FETCH_BLOCKED:network policy denied",
      0,
      "1 passed",
    ],
    [
      "rejects an unclassified fetch error",
      "fetch-blocked-classification",
      "FETCH_ERROR:opaque 403",
      1,
      "lacked denial evidence",
    ],
  ] as const)("%s from the fetch_url probe", (_label, selfTest, fixture, status, expected) => {
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
          NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST: selfTest,
          NEMOCLAW_E2E_FETCH_URL_PROBE_FIXTURE: fixture,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );

    expect(result.status).toBe(status);
    expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
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

  it.each([
    [
      "BLOCKED:policy denied",
      "ok",
      "preserve",
      0,
      /returns to the default Tavily denial/,
      /remains enabled/,
    ],
    [
      "REACHED:403",
      "ok",
      "preserve",
      1,
      /did not restore the default Tavily denial/,
      /remains enabled/,
    ],
    [
      "BLOCKED:policy denied",
      "fail",
      "preserve",
      1,
      /policy-remove tavily failed/,
      /remains enabled/,
    ],
    ["BLOCKED:policy denied", "ok", "lose", 1, /marker was lost/, /restored for ordered cleanup/],
  ])("restores Tavily denial after opt-in (%s/%s/%s)", (fixture, removeFixture, markerFixture, status, expected, markerExpected) => {
    const result = spawnSync("bash", [dcodeTavilyCheck], {
      encoding: "utf8",
      env: {
        NEMOCLAW_E2E_TAVILY_MARKER_FIXTURE: markerFixture,
        NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE: fixture,
        NEMOCLAW_E2E_TAVILY_REMOVE_FIXTURE: removeFixture,
        NEMOCLAW_E2E_TAVILY_SELF_TEST: "restore-denial",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SANDBOX_NAME: "deepagents-sandbox",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(expected);
    expect(result.stdout).toMatch(markerExpected);
  });

  it("keeps the managed DCode thread-auto-approval live check valid Bash (#6478)", () => {
    const scriptPath = path.join(
      process.cwd(),
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
    );
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("registers executable Deep Agents cloud-experimental checks in execution order", () => {
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
