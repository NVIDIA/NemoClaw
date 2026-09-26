// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path, { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { adminApprovalConnectScript } from "../fixtures/admin-approval-connect.ts";
import { createHostProcessWorkspace } from "../../helpers/host-process-harness.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  approveOpenClawAdminScope,
  captureManagedImageOnboardPairingDiagnostics,
  collectOnboardFailureDockerDiagnostics,
  managedActivationPostRestartAgentTurnScript,
  managedActivationOpenClawPluginScript,
  managedHermesBoundaryPoisonCommand,
  managedOpenClawSubagentCommand,
  ONBOARD_FAILURE_LOG_ARTIFACT_OPTIONS,
  preclean,
  summarizeOnboardFailureStartupSignals,
  waitForManagedActivationSandboxDeletion,
  waitForManagedActivationSandboxAbsence,
} from "../live/managed-image-activation-e2e-helpers.ts";
import { pendingAdminRequestId } from "../fixtures/issue-4462-admin-approval-evidence.ts";

const MANAGED_ADMIN_PUBLIC_KEY_BYTES = Buffer.from(
  Array.from({ length: 32 }, (_value, index) => index),
);
const MANAGED_ADMIN_PUBLIC_KEY = MANAGED_ADMIN_PUBLIC_KEY_BYTES.toString("base64url");
const MANAGED_ADMIN_DEVICE_ID = createHash("sha256")
  .update(MANAGED_ADMIN_PUBLIC_KEY_BYTES)
  .digest("hex");

function prepareManagedAdminState(root: string, requestId: string): NodeJS.ProcessEnv {
  const stateRoot = join(root, "state");
  const devicesPath = join(root, "devices.json");
  const helperPath = join(root, "openclaw_pairing_state.py");
  const identity = { deviceId: MANAGED_ADMIN_DEVICE_ID, publicKey: MANAGED_ADMIN_PUBLIC_KEY };
  const state = {
    pending: [
      {
        requestId,
        deviceId: MANAGED_ADMIN_DEVICE_ID,
        publicKey: MANAGED_ADMIN_PUBLIC_KEY,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing", "operator.read", "operator.write", "operator.admin"],
      },
    ],
    paired: [
      {
        deviceId: MANAGED_ADMIN_DEVICE_ID,
        publicKey: MANAGED_ADMIN_PUBLIC_KEY,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing", "operator.write"],
        approvedScopes: ["operator.pairing", "operator.write"],
        tokens: [
          {
            role: "operator",
            scopes: ["operator.pairing", "operator.read", "operator.write"],
          },
        ],
      },
    ],
  };
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(join(stateRoot, "pairing-state.json"), JSON.stringify({ identity }));
  fs.writeFileSync(devicesPath, JSON.stringify(state));
  fs.writeFileSync(
    helperPath,
    `import json\nfrom pathlib import Path\ndef read_openclaw_pairing_state(state_dir, timeout=1):\n    records=json.loads((Path(state_dir) / "pairing-state.json").read_text(encoding="utf-8"))\n    return records, {"timeout": timeout}\n`,
  );
  return {
    FAKE_DEVICES_STATE: devicesPath,
    NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER: helperPath,
    OPENCLAW_STATE_DIR: stateRoot,
  };
}

function runPostRestartAgentTurnFixture(statuses: string[], times: number[]) {
  const fixture = createHostProcessWorkspace("nemoclaw-openclaw-restart-ready-");
  const command = ["openclaw", "agent", "--session-id", "quoted session"];
  const script = managedActivationPostRestartAgentTurnScript("openclaw", "after", command);
  expect(script).not.toBeNull();

  writeFileSync(fixture.path("curl-statuses"), `${statuses.join("\n")}\n`);
  writeFileSync(fixture.path("times"), `${times.join("\n")}\n`);
  fixture.writeExecutable(
    "curl",
    `#!/bin/sh
attempt=0
if [ -f "$MANAGED_ACTIVATION_FIXTURE/curl-attempts" ]; then
  IFS= read -r attempt <"$MANAGED_ACTIVATION_FIXTURE/curl-attempts"
fi
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$MANAGED_ACTIVATION_FIXTURE/curl-attempts"
index=0
selected=000
while IFS= read -r status; do
  index=$((index + 1))
  if [ "$index" -eq "$attempt" ]; then
    selected=$status
    break
  fi
done <"$MANAGED_ACTIVATION_FIXTURE/curl-statuses"
printf '%s' "$selected"
`,
  );
  fixture.writeExecutable(
    "date",
    `#!/bin/sh
attempt=0
if [ -f "$MANAGED_ACTIVATION_FIXTURE/date-attempts" ]; then
  IFS= read -r attempt <"$MANAGED_ACTIVATION_FIXTURE/date-attempts"
fi
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$MANAGED_ACTIVATION_FIXTURE/date-attempts"
index=0
selected=0
while IFS= read -r value; do
  index=$((index + 1))
  if [ "$index" -eq "$attempt" ]; then
    selected=$value
    break
  fi
done <"$MANAGED_ACTIVATION_FIXTURE/times"
printf '%s\n' "$selected"
`,
  );
  fixture.writeExecutable(
    "sleep",
    `#!/bin/sh
printf '%s\n' "$1" >>"$MANAGED_ACTIVATION_FIXTURE/sleeps"
`,
  );
  fixture.writeExecutable(
    "openclaw",
    `#!/bin/sh
printf '%s\n' "$@" >"$MANAGED_ACTIVATION_FIXTURE/openclaw-args"
`,
  );

  try {
    const result = fixture.run(
      "/bin/sh",
      ["-lc", `PATH=${JSON.stringify(fixture.binDir)}\nexport PATH\n${String(script)}`],
      {
        env: { MANAGED_ACTIVATION_FIXTURE: fixture.root },
        killSignal: "SIGKILL",
        timeout: 10_000,
      },
    );
    const readLines = (name: string): string[] => {
      const file = join(fixture.root, name);
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
    };
    return {
      result,
      curlAttempts: readLines("curl-attempts"),
      sleeps: readLines("sleeps"),
      openclawArgs: readLines("openclaw-args"),
    };
  } finally {
    fixture.remove();
  }
}

describe("managed image activation failure diagnostics", () => {
  it("binds explicit admin approval to the exact request from the failed agent turn", () => {
    const requestId = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    const result = {
      exitCode: 1,
      stderr: `scope upgrade pending approval (requestId: ${requestId})`,
      stdout: "",
      timedOut: false,
    };

    expect(pendingAdminRequestId(result)).toBe(requestId);
    const input = adminApprovalConnectScript(
      "/fixture/nemoclaw",
      "fixture-sandbox",
      "managed-cron",
      requestId,
    );
    expect(input).toContain(`expected_request_id='${requestId}'`);
    expect(input).toContain('"$request_id_file" "$expected_request_id"');
    expect(input).toContain('openclaw devices approve "$request_id"');
    expect(input).toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(input).not.toContain(result.stderr);
  });

  it("proves the approved admin scope with a successful cron consumer", async () => {
    const requestId = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    const now = 1_790_145_221_718;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const sandboxExec = vi.fn().mockResolvedValueOnce({
      exitCode: 1,
      stderr: `scope upgrade pending approval (requestId: ${requestId})`,
      stdout: "",
      timedOut: false,
    });
    const hostCommand = vi.fn(async (_command: string, _args: string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout: "ISSUE_5324_ADMIN_APPROVAL_OK\n",
      timedOut: false,
    }));

    try {
      await approveOpenClawAdminScope(
        { command: hostCommand, commandPath: "/fixture/nemoclaw" } as never,
        { exec: sandboxExec } as never,
        "fixture-sandbox",
        {},
      );

      expect(hostCommand).toHaveBeenCalledOnce();
      expect(sandboxExec).toHaveBeenCalledOnce();
      expect(sandboxExec).toHaveBeenCalledWith(
        "fixture-sandbox",
        [
          "openclaw",
          "cron",
          "add",
          "--name",
          `managed-activation-admin-${now}`,
          "--every",
          "2h",
          "--agent",
          "main",
          "--session",
          "isolated",
          "--message",
          "hello",
        ],
        expect.objectContaining({ artifactName: "openclaw-cron-add-before-admin-approval" }),
      );
      const [command, args] = hostCommand.mock.calls[0]!;
      expect(command).toBe("bash");
      expect(args.slice(0, 1)).toEqual(["-lc"]);
      expect(args[1]).toContain(`managed-activation-admin-${now}`);
      expect(args[1]).toContain(`expected_request_id='${requestId}'`);
      expect(args[1]).toContain('openclaw cron run "$cron_id"');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("retains a fixed diagnostic without approval output secrets when approval fails", () => {
    const fixture = createHostProcessWorkspace("nemoclaw-managed-admin-approval-");
    const requestId = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    const secret = "approval-diagnostic-secret-value";
    fixture.writeExecutable("nemoclaw", "#!/bin/sh\nexec /bin/bash\n");
    fixture.writeExecutable(
      "openclaw",
      `#!/bin/sh
if [ "$1:$2" = "devices:list" ]; then cat "$FAKE_DEVICES_STATE"; exit 0; fi
printf 'approval denied by policy token=%s\n' "$APPROVAL_DIAGNOSTIC_SECRET" >&2
exit 91
`,
    );

    try {
      const result = fixture.run(
        "/bin/bash",
        [
          "-lc",
          `PATH=${JSON.stringify(fixture.binDir)}:$PATH
export PATH
${adminApprovalConnectScript("nemoclaw", "fixture-sandbox", "managed-cron", requestId)}`,
        ],
        {
          env: fixture.environment({
            ...prepareManagedAdminState(fixture.root, requestId),
            APPROVAL_DIAGNOSTIC_SECRET: secret,
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_GATEWAY_TOKEN: "fixture-token",
          }),
          killSignal: "SIGKILL",
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(27);
      expect(result.stderr).toContain("ADMIN_APPROVE_FAILED");
      expect(result.stderr).toContain("ADMIN_DIAGNOSTIC=authorization-rejected");
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(requestId);
    } finally {
      fixture.remove();
    }
  });

  it("refuses an output request ID that disagrees with canonical pending state", () => {
    const fixture = createHostProcessWorkspace("nemoclaw-managed-admin-selection-");
    const outputRequestId = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    const canonicalRequestId = "a96ada31-9cf9-4d99-97cc-978dcbb9fc39";
    fixture.writeExecutable("nemoclaw", "#!/bin/sh\nexec /bin/bash\n");
    fixture.writeExecutable(
      "openclaw",
      `#!/bin/sh
if [ "$1:$2" = "devices:list" ]; then cat "$FAKE_DEVICES_STATE"; exit 0; fi
printf '%s\n' "$*" >"$MANAGED_ADMIN_APPROVE_LOG"
`,
    );

    try {
      const approveLog = fixture.path("approve.log");
      const result = fixture.run(
        "/bin/bash",
        [
          "-lc",
          `PATH=${JSON.stringify(fixture.binDir)}:$PATH
export PATH
${adminApprovalConnectScript("nemoclaw", "fixture-sandbox", "managed-cron", outputRequestId)}`,
        ],
        {
          env: fixture.environment({
            ...prepareManagedAdminState(fixture.root, canonicalRequestId),
            MANAGED_ADMIN_APPROVE_LOG: approveLog,
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_GATEWAY_TOKEN: "fixture-token",
          }),
          killSignal: "SIGKILL",
          timeout: 10_000,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ADMIN_REQUEST_SELECTION_FAILED");
      expect(result.stderr).toContain("ADMIN_DIAGNOSTIC=command-failed");
      expect(existsSync(approveLog)).toBe(false);
      expect(result.stderr).not.toContain(outputRequestId);
      expect(result.stderr).not.toContain(canonicalRequestId);
    } finally {
      fixture.remove();
    }
  });

  it("rejects ambiguous admin request IDs", () => {
    const first = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    const second = "a96ada31-9cf9-4d99-97cc-978dcbb9fc39";
    expect(
      pendingAdminRequestId({
        exitCode: 1,
        stderr: [first, second]
          .map((requestId) => `scope upgrade pending approval (requestId: ${requestId})`)
          .join("\n"),
        stdout: "",
        timedOut: false,
      }),
    ).toBeNull();
  });

  it("waits only for the exact OpenShell Deleting phase and records each observation", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME CREATED PHASE\nmi-act-dcode now Deleting\n",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME CREATED PHASE\nmi-act-dcode now Deleting\n",
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "NAME CREATED PHASE\n" });
    const settleSleep = vi.fn(async () => {});

    const result = await waitForManagedActivationSandboxDeletion(
      { list } as never,
      "mi-act-dcode",
      { OPENSHELL_GATEWAY: "nemoclaw" },
      { sleep: settleSleep },
    );

    expect(result.stdout).not.toContain("mi-act-dcode");
    expect(settleSleep.mock.calls).toEqual([[1_000], [1_000]]);
    expect(list.mock.calls.map((call) => call[0]?.artifactName)).toEqual([
      "post-destroy-openshell-list-mi-act-dcode-attempt-1",
      "post-destroy-openshell-list-mi-act-dcode-attempt-2",
      "post-destroy-openshell-list-mi-act-dcode-attempt-3",
    ]);
  });

  it("does not retry a live sandbox or hide a persistent deletion", async () => {
    const ready = {
      exitCode: 0,
      stderr: "",
      stdout: "NAME CREATED PHASE\nmi-act-dcode now Ready\n",
    };
    const readyList = vi.fn(async () => ready);
    const readySleep = vi.fn(async () => {});
    await expect(
      waitForManagedActivationSandboxDeletion(
        { list: readyList } as never,
        "mi-act-dcode",
        {},
        { sleep: readySleep },
      ),
    ).resolves.toBe(ready);
    expect(readyList).toHaveBeenCalledOnce();
    expect(readySleep).not.toHaveBeenCalled();

    const deleting = {
      exitCode: 0,
      stderr: "",
      stdout: "NAME CREATED PHASE\nmi-act-dcode now Deleting\n",
    };
    const deletingList = vi.fn(async () => deleting);
    const deletingSleep = vi.fn(async () => {});
    await expect(
      waitForManagedActivationSandboxDeletion(
        { list: deletingList } as never,
        "mi-act-dcode",
        {},
        { sleep: deletingSleep },
      ),
    ).resolves.toBe(deleting);
    expect(deletingList).toHaveBeenCalledTimes(4);
    expect(deletingSleep.mock.calls).toEqual([[1_000], [1_000], [1_000]]);

    const failed = {
      exitCode: 1,
      stderr: "gateway unavailable",
      stdout: "mi-act-dcode now Deleting\n",
    };
    const failedList = vi.fn(async () => failed);
    const failedSleep = vi.fn(async () => {});
    await expect(
      waitForManagedActivationSandboxDeletion(
        { list: failedList } as never,
        "mi-act-dcode",
        {},
        { sleep: failedSleep },
      ),
    ).resolves.toBe(failed);
    expect(failedList).toHaveBeenCalledOnce();
    expect(failedSleep).not.toHaveBeenCalled();
  });

  it("retains redacted Docker logs for failed startup diagnosis", () => {
    expect(ONBOARD_FAILURE_LOG_ARTIFACT_OPTIONS).toEqual({ persistArtifacts: true });
  });

  it("redacts a copied failed-startup log before artifact publication", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-startup-diagnostics-"));
    const secret = "supplied-startup-diagnostic-secret";
    const containerId = "a".repeat(64);
    const artifacts = new ArtifactSink(directory);
    const command = vi.fn(async (executable: string, args: readonly string[]) => {
      switch (`${executable}:${String(args[0])}`) {
        case "docker:ps":
          return {
            exitCode: 0,
            stdout: `${containerId}\tmanaged-container\timage\tExited\n`,
            stderr: "",
          };
        case "docker:cp":
          fs.writeFileSync(String(args[2]), `startup log contains ${secret}\n`);
          break;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    try {
      await collectOnboardFailureDockerDiagnostics(
        artifacts,
        { command } as never,
        "openclaw",
        "managed-openclaw",
        {},
        [secret],
      );

      const published = fs.readFileSync(
        artifacts.pathFor(
          "managed-activation-onboard-failure-openclaw-container-1-nemoclaw-start.log",
        ),
        "utf8",
      );
      expect(published).toContain("[REDACTED]");
      expect(published).not.toContain(secret);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("installs activation proof plugins through native OpenClaw ownership", () => {
    const script = managedActivationOpenClawPluginScript();

    expect(script).toContain(
      'openclaw plugins install --force --accept-capabilities "$source_dir"',
    );
    expect(script).toContain("/sandbox/managed-activation-native-plugin");
    expect(script).not.toContain("plugins.allow");
    expect(script).not.toContain("openclawImagePluginInstalls");
  });

  it("prepares the Hermes restart refusal through the native .env boundary", () => {
    const command = managedHermesBoundaryPoisonCommand();
    expect(command).toContain("/sandbox/.hermes/.env");
    expect(command).toContain("DEVTEST_API_TOKEN=");
    expect(command).not.toContain("gateway restart");
  });

  it("drives the managed OpenClaw caller through sessions_spawn", () => {
    expect(managedOpenClawSubagentCommand("subagent-proof")).toEqual(
      expect.arrayContaining([
        "subagent-proof",
        expect.stringContaining("use sessions_spawn once"),
      ]),
    );
  });

  it("emits only the fixed setup signal from arbitrary container output (#8543)", () => {
    const secret = "untrusted-prompt-and-credential";
    const summary = summarizeOnboardFailureStartupSignals(
      [
        secret,
        "Setting up NemoClaw (Hermes)...",
        "Hermes runtime config guard refuses mutation under a foreign PID 1",
      ].join("\n"),
    );

    expect(summary.setupStarted).toBe(true);
    expect(summary).toEqual({ setupStarted: true });
    expect(Object.values(summary).every((value) => typeof value === "boolean")).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("captures bounded pairing stages only for OpenClaw onboarding failures (#9844)", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));

    await captureManagedImageOnboardPairingDiagnostics(
      { exec } as never,
      "openclaw",
      "mi-act-openclaw",
      { PATH: "/usr/bin" },
    );
    await captureManagedImageOnboardPairingDiagnostics(
      { exec } as never,
      "hermes",
      "mi-act-hermes",
      { PATH: "/usr/bin" },
    );

    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "mi-act-openclaw",
      ["node", "-e", expect.any(String), "/tmp/auto-pair.log", "/tmp/gateway.log"],
      expect.objectContaining({
        artifactName: "failure-openclaw-pairing-diagnostics",
        redactionValues: ["nemoclaw-managed-activation-e2e-key"],
      }),
    );
  });
  it("gates only the post-restart OpenClaw turn on inner gateway readiness (#7744)", () => {
    const command = ["openclaw", "agent", "--session-id", "quoted session"];
    const script = managedActivationPostRestartAgentTurnScript("openclaw", "after", command);

    expect(script).toContain("http://127.0.0.1:18789/health");
    expect(script).toContain("OpenClaw gateway did not become ready after OpenShell restart");
    expect(script).toContain("exec 'openclaw' 'agent' '--session-id' 'quoted session'");
    expect(managedActivationPostRestartAgentTurnScript("openclaw", "before", command)).toBeNull();
    expect(managedActivationPostRestartAgentTurnScript("openclaw", "boundary", command)).toBeNull();
    expect(managedActivationPostRestartAgentTurnScript("hermes", "after", command)).toBeNull();
  });

  it("retries post-restart OpenClaw readiness before executing the agent turn", () => {
    const execution = runPostRestartAgentTurnFixture(["503", "200"], [100, 100, 101]);

    expect(execution.result.status).toBe(0);
    expect(execution.curlAttempts).toEqual(["2"]);
    expect(execution.sleeps).toEqual(["2"]);
    expect(execution.openclawArgs).toEqual(["agent", "--session-id", "quoted session"]);
  });

  it("accepts post-restart OpenClaw authentication readiness", () => {
    const execution = runPostRestartAgentTurnFixture(["401"], [100, 100]);

    expect(execution.result.status).toBe(0);
    expect(execution.curlAttempts).toEqual(["1"]);
    expect(execution.sleeps).toEqual([]);
    expect(execution.openclawArgs).toEqual(["agent", "--session-id", "quoted session"]);
  });

  it("suppresses the OpenClaw agent turn when post-restart readiness times out", () => {
    const execution = runPostRestartAgentTurnFixture(["503"], [100, 100, 160]);

    expect(execution.result.status).toBe(1);
    expect(execution.result.stderr).toContain(
      "OpenClaw gateway did not become ready after OpenShell restart (last HTTP status: 503)",
    );
    expect(execution.curlAttempts).toEqual(["1"]);
    expect(execution.sleeps).toEqual(["2"]);
    expect(execution.openclawArgs).toEqual([]);
  });

  it("initializes cleanup then removes gateway state before cold onboarding", async () => {
    const calls: string[] = [];
    const host = {
      command: vi.fn(async () => {
        calls.push("start");
        return { exitCode: 0 };
      }),
      bestEffortCleanupSandbox: vi.fn(async () => {
        calls.push("destroy");
      }),
      cleanupGatewayRegistration: vi.fn(async () => {
        calls.push("remove-registration");
      }),
    };
    const lifecycle = {
      stopGatewayRuntime: vi.fn(async () => {
        calls.push("stop");
      }),
    };
    const sandbox = {
      cleanupSandbox: vi.fn(async () => {
        calls.push("delete");
      }),
    };
    await preclean(host as never, lifecycle as never, sandbox as never, "mi-act-openclaw", {
      HOME: "/job/home",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
    expect(calls).toEqual(["start", "destroy", "delete", "stop", "remove-registration"]);
    expect(host.command).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["nemoclaw"]),
      expect.objectContaining({ env: { HOME: "/job/home", OPENSHELL_GATEWAY: "nemoclaw" } }),
    );
    host.command.mockRejectedValueOnce(new Error("startup failed"));
    calls.length = 0;
    await expect(
      preclean(host as never, lifecycle as never, sandbox as never, "mi-act-openclaw", {
        OPENSHELL_GATEWAY: "nemoclaw",
      }),
    ).rejects.toThrow("startup failed");
    expect(calls).toEqual([]);
  });

  it("waits for a deleting managed activation sandbox to become absent", async () => {
    vi.useFakeTimers();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME            CREATED   PHASE\nmi-act-hermes   1m        Deleting\n",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "NAME   CREATED   PHASE\n",
      });

    try {
      const absence = waitForManagedActivationSandboxAbsence({ list } as never, "mi-act-hermes", {
        OPENSHELL_GATEWAY: "nemoclaw",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await absence;
    } finally {
      vi.useRealTimers();
    }

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        artifactName: "post-destroy-openshell-list-mi-act-hermes-attempt-01",
      }),
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        artifactName: "post-destroy-openshell-list-mi-act-hermes-attempt-02",
      }),
    );
  });

  it("fails when OpenShell still lists the managed activation sandbox at the cleanup deadline", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "NAME            CREATED   PHASE\nmi-act-hermes   1m        Deleting\n",
    }));

    try {
      const absence = waitForManagedActivationSandboxAbsence({ list } as never, "mi-act-hermes", {
        OPENSHELL_GATEWAY: "nemoclaw",
      });
      const assertion = expect(absence).rejects.toThrow("polling exhausted its configured bound");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops when OpenShell cannot list sandboxes during cleanup verification", async () => {
    const list = vi.fn(async () => ({
      exitCode: 1,
      stderr: "gateway transport unavailable",
      stdout: "",
    }));

    await expect(
      waitForManagedActivationSandboxAbsence({ list } as never, "mi-act-hermes", {
        OPENSHELL_GATEWAY: "nemoclaw",
      }),
    ).rejects.toThrow("list OpenShell sandboxes after managed activation destroy failed");
    expect(list).toHaveBeenCalledOnce();
  });
});
