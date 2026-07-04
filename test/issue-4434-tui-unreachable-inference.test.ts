// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  classifyIssue4434AcceptanceFields,
  extractFinalIssue4434ErrorBlock,
  hasFullIssue4434Diagnostics,
  stripTerminalControl,
} from "./e2e/support/issue-4434-tui-capture.ts";

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

const VISIBLE_ERROR_RE =
  /\b(error|failed|timeout|timed out|unavailable|fetch failed|ETIMEDOUT|ECONN|upstream)\b/i;
const TUI_RUN_ERROR_RE = /\brun\s+error:/i;
const TUI_ERROR_CAUSE_RE =
  /\brun\s+error:.*\b(error|failed|timeout|timed out|unavailable|fetch failed|ETIMEDOUT|ECONN|upstream)\b/i;
const CONNECTED_SPINNER_RE =
  /(?:flibbertigibbeting|thinking|waiting|processing).*?\|\s*connected|[0-9]+m\s+[0-9]+s\s*\|\s*connected/i;

function analyzeIssue4434TuiCapture(capture: string) {
  const plain = stripTerminalControl(capture);
  const lines = plain.split(/\n/).map((line) => line.trim());
  const runErrorLines = lines.filter((line) => TUI_RUN_ERROR_RE.test(line));
  const runErrorLineWithCause = runErrorLines.find((line) => TUI_ERROR_CAUSE_RE.test(line)) ?? "";
  const finalErrorBlock = extractFinalIssue4434ErrorBlock(plain);
  const diagnosticFields = classifyIssue4434AcceptanceFields(finalErrorBlock);
  const visibleError = VISIBLE_ERROR_RE.test(plain);
  const connectedSpinner = CONNECTED_SPINNER_RE.test(plain);
  return {
    visibleError,
    runErrorLinePresent: runErrorLines.length > 0,
    runErrorLine: runErrorLineWithCause || runErrorLines.at(-1) || "",
    runErrorLineHasCause: runErrorLineWithCause.length > 0,
    finalErrorBlock,
    diagnosticFields,
    hasFullDiagnostics: hasFullIssue4434Diagnostics(diagnosticFields),
    connectedSpinner,
    issue4434Signature: connectedSpinner && !visibleError,
  };
}

function renderTui(state: TuiState): string {
  const statusLine = state.spinnerActive
    ? "flibbertigibbeting... | connected"
    : `running | ${state.status}`;
  return [...state.terminalLines, statusLine].join("\n");
}

function applyChatEventToTui(state: TuiState, event: ChatEvent): TuiState {
  if (event.state === "error") {
    const text = event.errorMessage || event.message?.text || "OpenClaw chat.send failed";
    return {
      spinnerActive: false,
      status: "error",
      terminalLines: [...state.terminalLines, `run error: ${text}`],
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

describe("unreachable inference TUI behavior (#4434)", () => {
  it("classifies the captured spinner plus connected status with no error as the broken signature", () => {
    const capture = [
      "  flibbertigibbeting... - 3m 42s | connected",
      "agent main | session main | inference/nvidia/nemotron-3-super-120b-a12b",
      "",
    ].join("\n");

    expect(analyzeIssue4434TuiCapture(capture)).toEqual({
      visibleError: false,
      runErrorLinePresent: false,
      runErrorLine: "",
      runErrorLineHasCause: false,
      finalErrorBlock: "",
      diagnosticFields: {
        httpStatusOrCause: false,
        reportingLayer: false,
        recoveryHint: false,
      },
      hasFullDiagnostics: false,
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
      runErrorLinePresent: true,
      runErrorLine:
        "run error: upstream inference endpoint fetch failed: connect ETIMEDOUT 75.2.113.119:443. Check network connectivity or retry after restoring endpoint access.",
      runErrorLineHasCause: true,
      connectedSpinner: false,
      issue4434Signature: false,
    });
  });

  it("requires the unreachable-inference cause on the same run error line", () => {
    const capture = [
      "user: hello",
      "run error:",
      "upstream inference endpoint fetch failed: connect ETIMEDOUT 75.2.113.119:443",
      "running | error",
    ].join("\n");

    expect(analyzeIssue4434TuiCapture(capture)).toMatchObject({
      visibleError: true,
      runErrorLinePresent: true,
      runErrorLine: "run error:",
      runErrorLineHasCause: false,
      connectedSpinner: false,
      issue4434Signature: false,
    });
  });

  it("requires every diagnostic field in the final contiguous run-error block", () => {
    const complete = [
      "user: hello",
      "run error: TypeError: fetch failed",
      "Cause: fetch failed while reaching the upstream API.",
      "Reporting layer: gateway proxy / upstream API.",
      "Recovery hint: check sandbox egress and provider reachability, then retry.",
      "running | error",
    ].join("\n");

    expect(analyzeIssue4434TuiCapture(complete)).toMatchObject({
      finalErrorBlock: [
        "run error: TypeError: fetch failed",
        "Cause: fetch failed while reaching the upstream API.",
        "Reporting layer: gateway proxy / upstream API.",
        "Recovery hint: check sandbox egress and provider reachability, then retry.",
      ].join("\n"),
      diagnosticFields: {
        httpStatusOrCause: true,
        reportingLayer: true,
        recoveryHint: true,
      },
      hasFullDiagnostics: true,
    });
  });

  it("does not borrow diagnostic keywords from unrelated earlier transcript lines", () => {
    const incomplete = [
      "earlier probe returned HTTP 503",
      "earlier note mentioned the upstream API",
      "earlier suggestion said retry",
      "run error: HTTP 503 from upstream API; retry after restoring the provider",
      "running | error",
      "user: try once more",
      "run error: TypeError: fetch failed",
      "running | error",
    ].join("\n");

    expect(analyzeIssue4434TuiCapture(incomplete)).toMatchObject({
      finalErrorBlock: "run error: TypeError: fetch failed",
      diagnosticFields: {
        httpStatusOrCause: false,
        reportingLayer: false,
        recoveryHint: false,
      },
      hasFullDiagnostics: false,
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
