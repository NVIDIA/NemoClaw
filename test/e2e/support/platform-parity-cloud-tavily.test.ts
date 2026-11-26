// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import { canonicalTargets } from "../registry/definitions/baseline.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import {
  buildCloudExperimentalCommandEnv,
  runE2eCloudExperimentalChecks,
} from "../live/cloud-experimental-checks.ts";

const dcodeTavilyCheck = path.join(
  process.cwd(),
  "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
);
const DEFAULT_TEST_PATH = process.env.PATH ?? "/usr/bin:/bin";
const tavilyBlocked = "BLOCKED:policy denied";
const observabilityEnabled = "enabled";
const denialRestored = /returns to the default Tavily denial/;
const denialNotRestored = /did not restore the default Tavily denial/;
const policyRemoveFailed = /policy-remove tavily failed/;
const observabilityPreserved = /preserve enabled observability after policy-remove/;
const observabilityDriftedAfter = /observability state drifted after policy-remove/;
const observabilityDriftedBefore = /observability state drifted before Tavily policy mutation/;

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

describe("Deep Agents Tavily opt-in and revocation", () => {
  it.each([
    ["probe-command-shape", 0, "NATIVE_MULTILINE_ARGV\n"],
    ["authenticated-probe-retry", 0, "REACHED:200\nCALLS:1\n"],
    ["authenticated-probe-retry", 2, "REACHED:200\nCALLS:3\n"],
    ["authenticated-probe-retry", 20, "REACHED:401\nCALLS:10\n"],
  ])("passes the Deep Agents Tavily %s self-test (%i unresolved)", (mode, n, expected) => {
    const result = spawnSync("bash", [dcodeTavilyCheck], {
      encoding: "utf8",
      env: {
        NEMOCLAW_E2E_TAVILY_SELF_TEST: mode,
        NEMOCLAW_E2E_TAVILY_UNRESOLVED_PROBES: String(n),
        PATH: DEFAULT_TEST_PATH,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
  });

  it.each([
    [tavilyBlocked, "ok", observabilityEnabled, 0, denialRestored, observabilityPreserved],
    ["REACHED:403", "ok", observabilityEnabled, 1, denialNotRestored, observabilityPreserved],
    [tavilyBlocked, "fail", observabilityEnabled, 1, policyRemoveFailed, observabilityPreserved],
    [
      tavilyBlocked,
      "clear-marker",
      observabilityEnabled,
      1,
      denialRestored,
      observabilityDriftedAfter,
    ],
    [tavilyBlocked, "ok", "disabled", 1, observabilityDriftedBefore, /registry=disabled, marker=1/],
  ])(
    "restores the default Tavily denial without observability drift (%s/%s/%s)",
    (fixture, removeFixture, registryFixture, status, expected, observabilityExpected) => {
      const result = spawnSync("bash", [dcodeTavilyCheck], {
        encoding: "utf8",
        env: {
          NEMOCLAW_E2E_OBSERVABILITY_REGISTRY_FIXTURE: registryFixture,
          NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE: fixture,
          NEMOCLAW_E2E_TAVILY_REMOVE_FIXTURE: removeFixture,
          NEMOCLAW_E2E_TAVILY_SELF_TEST: "restore-denial",
          PATH: DEFAULT_TEST_PATH,
          SANDBOX_NAME: "deepagents-sandbox",
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(expected);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(observabilityExpected);
      expect(fs.readFileSync(dcodeTavilyCheck, "utf8")).toContain(
        "trap 'cleanup_tavily_check || exit 1' EXIT",
      );
    },
  );

  it.each([
    ["<unset>", "0", "ok", 0],
    ["true", "0", "ok", 0],
    ["false", "0", "ok", 0],
    ["<unset>", "1", "ok", 1],
    ["true", "1", "ok", 1],
    ["false", "1", "ok", 1],
    ["true", "0", "fail", 1],
  ])(
    "restores audit setting %s after removal status %s and restoration %s (#13082)",
    (before, removeStatus, restoreStatus, expectedStatus) => {
      const result = spawnSync("bash", [dcodeTavilyCheck], {
        encoding: "utf8",
        env: {
          PATH: DEFAULT_TEST_PATH,
          NEMOCLAW_E2E_TAVILY_SELF_TEST: "audit-cleanup",
          NEMOCLAW_E2E_AUDIT_BEFORE: before as string,
          NEMOCLAW_E2E_REMOVE_STATUS: removeStatus as string,
          NEMOCLAW_E2E_AUDIT_RESTORE_FIXTURE: restoreStatus as string,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
      expect(result.stdout).toContain(`RESTORED:${before}`);
    },
  );

  it.each([
    { stage: "register", status: 1, policy: "present", calls: ["register", "provider-reset"] },
    {
      stage: "attach",
      status: 1,
      policy: "present",
      calls: ["register", "attach", "provider-reset"],
    },
    {
      stage: "policy-add",
      status: 1,
      policy: "present",
      calls: ["register", "attach", "policy-add", "provider-reset"],
    },
    {
      stage: "probe",
      status: 1,
      policy: "absent",
      calls: ["register", "attach", "policy-add", "policy-remove", "provider-reset"],
    },
    {
      stage: "complete",
      status: 0,
      policy: "absent",
      calls: ["register", "attach", "policy-add", "policy-remove", "provider-reset"],
    },
  ])(
    "limits Tavily cleanup to completed opt-in setup ($stage)",
    ({ stage, status, policy, calls }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tavily-setup-"));
      const cli = path.join(root, "nemoclaw.cjs");
      const callLog = path.join(root, "calls");
      const audit = path.join(root, "audit");
      const policyState = path.join(root, "policy");
      try {
        fs.mkdirSync(path.join(root, ".nemoclaw"));
        fs.writeFileSync(
          path.join(root, ".nemoclaw", "sandboxes.json"),
          JSON.stringify({
            sandboxes: {
              "deepagents-sandbox": {
                agent: "langchain-deepagents-code",
                observabilityEnabled: true,
              },
            },
          }),
        );
        fs.writeFileSync(callLog, "");
        fs.writeFileSync(audit, "false");
        fs.writeFileSync(policyState, "present");
        fs.writeFileSync(
          cli,
          String.raw`const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_ROOT;
const args = process.argv.slice(2);
const record = (value) => fs.appendFileSync(path.join(root, "calls"), value + "\n");
if (args.includes("--dry-run")) { console.log("api.tavily.com"); process.exit(0); }
switch (args.slice(0, 2).join(" ")) {
  case "credentials add":
    record("register");
    if (process.env.FAILURE_STAGE === "register") process.exit(1);
    fs.writeFileSync(path.join(root, "provider"), args[2]);
    break;
  case "credentials reset":
    record("provider-reset");
    fs.rmSync(path.join(root, "provider"), { force: true });
    break;
  case "deepagents-sandbox policy-add":
    record("policy-add");
    if (process.env.FAILURE_STAGE === "policy-add") process.exit(1);
    fs.writeFileSync(path.join(root, "policy"), "present");
    break;
  case "deepagents-sandbox policy-remove":
    record("policy-remove");
    fs.writeFileSync(path.join(root, "policy"), "absent");
    break;
  default: process.exit(2);
}
`,
        );
        fs.writeFileSync(
          path.join(root, "openshell"),
          String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_ROOT;
const args = process.argv.slice(2);
const audit = path.join(root, "audit");
const projectPython = "/sandbox/.nemoclaw-e2e-project-venv/bin/python3";
switch (args.slice(0, 2).join(" ")) {
  case "settings get":
    console.log(JSON.stringify({ settings: { ocsf_json_enabled: { scope: "sandbox", value: fs.readFileSync(audit, "utf8") } } }));
    break;
  case "settings set":
    fs.writeFileSync(audit, args[args.indexOf("--value") + 1]);
    break;
  case "sandbox provider":
    fs.appendFileSync(path.join(root, "calls"), "attach\n");
    if (process.env.FAILURE_STAGE === "attach") process.exit(1);
    break;
  case "sandbox exec": {
    const command = args.slice(args.indexOf("--") + 1);
    if (command[0] === "sh") { console.log("1"); break; }
    if (command[0] === "bash") {
      console.log(command.join(" ").includes("/sandbox/.nemoclaw-e2e-project-venv")
        ? projectPython : "/opt/venv/bin/python3");
      break;
    }
    const permitted = fs.readFileSync(path.join(root, "policy"), "utf8") === "present";
    if (process.env.FAILURE_STAGE === "probe" && permitted) process.exit(1);
    console.log("PROBE_PID:4242");
    console.log(permitted && command[0] !== "/usr/bin/python3" && command[0] !== projectPython
      ? "REACHED:200" : "BLOCKED:policy denied");
    break;
  }
  default: process.exit(2);
}
`,
          { mode: 0o755 },
        );
        const result = spawnSync("bash", [dcodeTavilyCheck], {
          encoding: "utf8",
          env: {
            PATH: `${root}:${DEFAULT_TEST_PATH}`,
            HOME: root,
            FIXTURE_ROOT: root,
            FAILURE_STAGE: stage,
            SANDBOX_NAME: "deepagents-sandbox",
            NEMOCLAW_E2E_CLI: cli,
            NEMOCLAW_E2E_POLICY_SETTLE_SECONDS: "0",
            NEMOCLAW_E2E_TAVILY_AUTHENTICATED: "1",
            TAVILY_API_KEY: "tavily-fixture-key",
            NEMOCLAW_E2E_TAVILY_AUDIT_BEFORE_FIXTURE: "[100] old event",
            NEMOCLAW_E2E_TAVILY_AUDIT_FIXTURE:
              "[101] [sandbox] [OCSF] [ocsf] NET:OPEN [WARN] DENIED python3(4242) -> api.tavily.com:443",
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(status);
        expect(fs.readFileSync(policyState, "utf8")).toBe(policy);
        expect(fs.readFileSync(callLog, "utf8").trim().split("\n")).toEqual(calls);
        expect(fs.readFileSync(audit, "utf8")).toBe("false");
        expect(fs.existsSync(path.join(root, "provider"))).toBe(false);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("keeps Tavily credentials out of the cloud check environment (#13082)", () => {
    const env = buildCloudExperimentalCommandEnv("sandbox", "inference-key", {
      TAVILY_API_KEY: "ambient-key",
      OTHER_SECRET: "unrelated-key",
      NEMOCLAW_E2E_TAVILY_AUTHENTICATED: "1",
    });
    expect(env).not.toHaveProperty("TAVILY_API_KEY");
    expect(env).not.toHaveProperty("OTHER_SECRET");
    expect(env).not.toHaveProperty("NEMOCLAW_E2E_TAVILY_AUTHENTICATED");
    expect(
      canonicalTargets().find(
        (target) => target.id === "ubuntu-repo-cloud-langchain-deepagents-code",
      )?.requiredSecrets,
    ).toEqual(["NVIDIA_INFERENCE_API_KEY"]);
  });

  it.each([undefined, "", "tavily-fixture-key"])(
    "runs the credential-free Tavily check when its key is %s (#13082)",
    async (tavilyKey) => {
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tavily-free-"));
      const run = vi.fn(async (_command: TrustedShellCommand, _options?: ShellProbeRunOptions) =>
        shellResult(0, ""),
      );
      const tavilyScript =
        "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh";
      const nextScript =
        "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh";
      try {
        await runE2eCloudExperimentalChecks(
          "ubuntu-repo-cloud-langchain-deepagents-code",
          "sandbox",
          [tavilyScript, nextScript],
          {
            artifacts: new ArtifactSink(artifactRoot),
            cleanup: new CleanupRegistry(),
            host: new HostCliClient({ run }),
            secrets: new SecretStore({ TAVILY_API_KEY: tavilyKey }, (note) => {
              throw new Error(note);
            }),
          },
        );
        expect(run.mock.calls.map(([command]) => command)).toEqual([
          expect.objectContaining({ command: "openshell" }),
          expect.objectContaining({
            command: "bash",
            args: [path.join(process.cwd(), tavilyScript)],
          }),
          expect.objectContaining({
            command: "bash",
            args: [path.join(process.cwd(), nextScript)],
          }),
        ]);
        expect(run.mock.calls[0]?.[1]?.env).not.toHaveProperty("TAVILY_API_KEY");
        expect(run.mock.calls[2]?.[1]?.env).not.toHaveProperty("TAVILY_API_KEY");
        const tavilyEnv = run.mock.calls[1]?.[1]?.env;
        expect(tavilyEnv).not.toHaveProperty("TAVILY_API_KEY");
        expect(tavilyEnv).not.toHaveProperty("NEMOCLAW_E2E_TAVILY_AUTHENTICATED");
      } finally {
        fs.rmSync(artifactRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([shellResult(1, "Tavily denial failed"), shellResult(0, "SKIP: Tavily unavailable")])(
    "rejects a credential-free Tavily check that fails or skips (%j)",
    async (result) => {
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tavily-failure-"));
      const run = vi.fn().mockResolvedValueOnce(shellResult(0, "")).mockResolvedValueOnce(result);
      try {
        await expect(
          runE2eCloudExperimentalChecks(
            "ubuntu-repo-cloud-langchain-deepagents-code",
            "sandbox",
            ["test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh"],
            {
              artifacts: new ArtifactSink(artifactRoot),
              cleanup: new CleanupRegistry(),
              host: new HostCliClient({ run }),
              secrets: new SecretStore({}, (note) => {
                throw new Error(note);
              }),
            },
          ),
        ).rejects.toThrow();
      } finally {
        fs.rmSync(artifactRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "denied",
    "allowed",
    "stale",
    "wrong-host",
    "wrong-pid",
    "wrong-port",
    "wrong-binary",
    "missing-pid",
  ])("requires post-removal Tavily audit evidence with %s events (#13082)", (event) => {
    const cursor = Math.floor(Date.now() / 1000);
    const epoch = event === "stale" ? cursor - 1 : cursor + 1;
    const pid = event === "wrong-pid" ? 4243 : 4242;
    const port = event === "wrong-port" ? 8443 : 443;
    const binary = event === "wrong-binary" ? "node" : "python3.12";
    const host = event === "wrong-host" ? "other.example.com" : "api.tavily.com";
    const decision = event === "allowed" ? "ALLOWED" : "DENIED";
    const result = spawnSync("bash", [dcodeTavilyCheck], {
      encoding: "utf8",
      env: {
        PATH: DEFAULT_TEST_PATH,
        SANDBOX_NAME: "deepagents-sandbox",
        NEMOCLAW_E2E_TAVILY_SELF_TEST: "restore-denial",
        NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE:
          event === "missing-pid" ? tavilyBlocked : `PROBE_PID:4242\n${tavilyBlocked}`,
        NEMOCLAW_E2E_TAVILY_AUTHENTICATED: "1",
        NEMOCLAW_E2E_TAVILY_AUDIT_BEFORE_FIXTURE: `[${cursor}] old event`,
        NEMOCLAW_E2E_TAVILY_AUDIT_FIXTURE: `[${epoch}] [sandbox] [OCSF] [ocsf] NET:OPEN [WARN] ${decision} ${binary}(${pid}) -> ${host}:${port}`,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(event === "denied" ? 0 : 1);
  });
});
