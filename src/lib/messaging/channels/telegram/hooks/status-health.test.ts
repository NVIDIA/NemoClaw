// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { MessagingHookContext, MessagingHookResult } from "../../../hooks/types";
import type { ChannelHealthReport } from "../../channel-health";
import { createTelegramStatusHealthHook } from "./status-health";

const BASE_INPUTS = {
  currentSandbox: "alpha",
  agent: "openclaw",
  probedAt: "2026-07-14T00:00:00.000Z",
  channelEnabledInRegistry: true,
  presetApplied: true,
  presetOnGateway: true,
};

function context(
  inputs: Record<string, unknown> = BASE_INPUTS,
  channelId = "telegram",
): MessagingHookContext {
  return {
    channelId,
    hookId: "telegram-status-health",
    phase: "status",
    inputs,
  } as unknown as MessagingHookContext;
}

function probeStdout(logLines: string[], procLines: string[]): string {
  return [
    "NEMOCLAW_TG_DIAG_OK",
    "NEMOCLAW_TG_LOG_BEGIN",
    ...logLines,
    "NEMOCLAW_TG_LOG_END",
    ...procLines,
    "NEMOCLAW_TG_PROC_DONE",
  ].join("\n");
}

type ExecResult = { status: number; stdout: string; stderr: string } | null;

function makeExec(result: ExecResult) {
  return vi.fn(
    async (_sandbox: string, _command: string, _timeout: number): Promise<ExecResult> => result,
  );
}

function reportOf(result: MessagingHookResult): ChannelHealthReport | undefined {
  const value = result.outputs?.channelHealth?.value as unknown as
    | { report?: ChannelHealthReport }
    | undefined;
  return value?.report;
}

function outputsOf(result: MessagingHookResult) {
  return result.outputs;
}

describe("telegram.statusHealth hook", () => {
  it("probes the gateway log and reports healthy for a ready bridge with inbound (#6743)", async () => {
    const exec = makeExec({
      status: 0,
      stdout: probeStdout(
        [
          "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
          "[telegram] [default] inbound update received (update_id=present; message_id=present)",
        ],
        ["PROC 42 node /opt/openclaw gateway"],
      ),
      stderr: "",
    });
    const result = await createTelegramStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("healthy");

    // The probe reads the gateway's own breadcrumbs and never calls the Bot API.
    const command = exec.mock.calls[0]?.[1] ?? "";
    expect(command).toMatch(/\/tmp\/gateway\.log/);
    expect(command).toMatch(/pgrep/);
    expect(command).not.toMatch(/getMe/i);
    expect(command).not.toMatch(/curl/i);
  });

  it("emits a syntactically valid /bin/sh probe script (#6743)", async () => {
    // The probe is a multiline sh script (grep/awk pipelines, marker sequencing).
    // A shell syntax regression would fail every real probe while mocked-stdout
    // tests stay green, so validate the generated command with `sh -n`.
    const exec = makeExec({ status: 0, stdout: probeStdout([], []), stderr: "" });
    await createTelegramStatusHealthHook({ executeSandboxCommand: exec })(context());
    const command = exec.mock.calls[0]?.[1] ?? "";
    const validation = spawnSync("sh", ["-n", "-c", command], { encoding: "utf-8" });
    expect(validation.status, validation.stderr || validation.stdout).toBe(0);
    // The probe must filter its own pgrep line out of the process results.
    expect(command).toMatch(/__nemoclaw_tg_self_pid/);
    expect(command).toMatch(/pgrep -fa/);
  });

  it("reports not_started when pgrep completes with no gateway process", async () => {
    const exec = makeExec({ status: 0, stdout: probeStdout([], []), stderr: "" });
    const result = await createTelegramStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("not_started");
  });

  it("reports probe_failed when the sandbox exec fails", async () => {
    const exec = makeExec(null);
    const result = await createTelegramStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("probe_failed");
  });

  it("treats a non-zero exec as a failed probe even with healthy-looking stdout (#6887)", async () => {
    // A timed-out/killed exec can still carry partial stdout with a stale
    // provider-ready line — a non-zero status must not read as healthy.
    const exec = makeExec({
      status: 1,
      stdout: probeStdout(
        [
          "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
        ],
        ["PROC 42 node /opt/openclaw gateway"],
      ),
      stderr: "sandbox exec timed out",
    });
    const result = await createTelegramStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("probe_failed");
  });

  it("derives config_gap / policy_gap from the host-fact inputs", async () => {
    const exec = makeExec({ status: 0, stdout: probeStdout([], []), stderr: "" });
    const hook = createTelegramStatusHealthHook({ executeSandboxCommand: exec });
    expect(
      reportOf(await hook(context({ ...BASE_INPUTS, channelEnabledInRegistry: false })))?.verdict,
    ).toBe("config_gap");
    expect(reportOf(await hook(context({ ...BASE_INPUTS, presetApplied: false })))?.verdict).toBe(
      "policy_gap",
    );
  });

  it("no-ops for a non-telegram channel or without an exec runner", async () => {
    const exec = makeExec({ status: 0, stdout: probeStdout([], []), stderr: "" });
    expect(
      outputsOf(
        await createTelegramStatusHealthHook({ executeSandboxCommand: exec })(
          context(BASE_INPUTS, "slack"),
        ),
      ),
    ).toBeUndefined();
    expect(outputsOf(await createTelegramStatusHealthHook({})(context()))).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});
