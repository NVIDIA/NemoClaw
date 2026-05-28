// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

type ChatEvent = {
  state: "delta" | "final" | "error";
  message?: { role: string; text?: string };
  errorMessage?: string;
};

type TuiState = {
  spinnerActive: boolean;
  status: "connected" | "error";
  terminalLines: string[];
};

const VISIBLE_ERROR_RE = /\b(error|failed|timeout|timed out|unavailable|fetch failed|upstream|connection)\b/i;
const ERROR_CAUSE_RE =
  /\b(?:HTTP\s*(?:status\s*)?\d{3}|fetch failed|ETIMEDOUT|ECONN(?:REFUSED|RESET|ABORTED)?|ENOTFOUND|EAI_AGAIN|timeout|timed out|unavailable)\b/i;
const ERROR_LAYER_RE = /\b(?:gateway|proxy|upstream|inference|endpoint|provider|chat\.send)\b/i;
const RECOVERY_HINT_RE =
  /\b(?:retry|try again|check|verify|network|firewall|endpoint|connectivity|NVIDIA|API key|provider)\b/i;
const CONNECTED_SPINNER_RE =
  /(?:flibbertigibbeting|thinking|waiting|processing).*?\|\s*connected|[0-9]+m\s+[0-9]+s\s*\|\s*connected/i;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function analyzeIssue4434TuiCapture(capture: string) {
  const plain = stripAnsi(capture);
  const errorContext = plain
    .split(/\r?\n/)
    .filter(
      (line) =>
        VISIBLE_ERROR_RE.test(line) ||
        ERROR_CAUSE_RE.test(line) ||
        /\|\s*error\b/i.test(line),
    )
    .join("\n");
  const visibleError = VISIBLE_ERROR_RE.test(plain);
  const concreteCause = ERROR_CAUSE_RE.test(errorContext);
  const reportingLayer = ERROR_LAYER_RE.test(errorContext);
  const recoveryHint = RECOVERY_HINT_RE.test(errorContext);
  const connectedSpinner = CONNECTED_SPINNER_RE.test(plain);
  return {
    visibleError,
    concreteCause,
    reportingLayer,
    recoveryHint,
    connectedSpinner,
    issue4434Signature: connectedSpinner && !visibleError,
  };
}

function renderTui(state: TuiState): string {
  const statusLine = state.spinnerActive
    ? "flibbertigibbeting... | connected"
    : `status: ${state.status}`;
  return [...state.terminalLines, statusLine].join("\n");
}

function applyChatEventToTui(state: TuiState, event: ChatEvent): TuiState {
  if (event.state === "error") {
    const text = event.errorMessage || event.message?.text || "OpenClaw chat.send failed";
    return {
      spinnerActive: false,
      status: "error",
      terminalLines: [...state.terminalLines, `Error: ${text}`],
    };
  }
  if (event.state === "final") {
    return {
      spinnerActive: false,
      status: "connected",
      terminalLines: event.message?.text
        ? [...state.terminalLines, event.message.text]
        : state.terminalLines,
    };
  }
  return state;
}

function driveMockOpenClawGatewayChatPath(params: {
  endpointReachable: boolean;
  broadcastSyncErrors: boolean;
}) {
  const events: ChatEvent[] = [];
  const tuiInitialState: TuiState = {
    spinnerActive: true,
    status: "connected",
    terminalLines: ["user: hello"],
  };

  try {
    if (!params.endpointReachable) {
      throw new Error(
        "upstream inference endpoint fetch failed: connect ETIMEDOUT 75.2.113.119:443. Check network connectivity or retry after restoring endpoint access.",
      );
    }
    events.push({ state: "final", message: { role: "assistant", text: "hello" } });
  } catch (error) {
    if (params.broadcastSyncErrors) {
      events.push({
        state: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const finalState = events.reduce(applyChatEventToTui, tuiInitialState);
  return {
    events,
    capture: renderTui(finalState),
    state: finalState,
  };
}

describe("issue #4434 unreachable inference TUI behavior", () => {
  it("classifies the captured spinner plus connected status with no error as the broken signature", () => {
    const capture = [
      "  flibbertigibbeting... - 3m 42s | connected",
      "agent main | session main | inference/nvidia/nemotron-3-super-120b-a12b",
      "",
    ].join("\n");

    expect(analyzeIssue4434TuiCapture(capture)).toEqual({
      visibleError: false,
      concreteCause: false,
      reportingLayer: false,
      recoveryHint: false,
      connectedSpinner: true,
      issue4434Signature: true,
    });
  });

  it("drives the gateway chat path with an unreachable endpoint and requires a visible TUI error", () => {
    const result = driveMockOpenClawGatewayChatPath({
      endpointReachable: false,
      broadcastSyncErrors: true,
    });

    expect(result.events).toEqual([
      {
        state: "error",
        errorMessage:
          "upstream inference endpoint fetch failed: connect ETIMEDOUT 75.2.113.119:443. Check network connectivity or retry after restoring endpoint access.",
      },
    ]);
    expect(result.state.spinnerActive).toBe(false);
    expect(result.state.status).toBe("error");
    expect(analyzeIssue4434TuiCapture(result.capture)).toMatchObject({
      visibleError: true,
      concreteCause: true,
      reportingLayer: true,
      recoveryHint: true,
      connectedSpinner: false,
      issue4434Signature: false,
    });
  });

  it("keeps failing when the gateway drops the synchronous chat.send error event", () => {
    const result = driveMockOpenClawGatewayChatPath({
      endpointReachable: false,
      broadcastSyncErrors: false,
    });

    expect(result.events).toEqual([]);
    expect(result.state.spinnerActive).toBe(true);
    expect(analyzeIssue4434TuiCapture(result.capture).issue4434Signature).toBe(true);
  });
});
