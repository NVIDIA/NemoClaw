// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { createHostProcessWorkspace } from "../../helpers/host-process-harness.ts";
import { cleanupExistingPath, terminateProcessIfRunning } from "../fixtures/cleanup-resources.ts";
import { observabilityProbeThreadId } from "../live/deepagents-observability-contract.ts";
import { traceRequest } from "./deepagents-observability-contract-fixtures.ts";

const threadId = "01900000-0000-7000-8000-000000000001";
const probeCwd = "/sandbox/.deepagents/nemoclaw-otlp-live.fixture";
const nativeList = (data: unknown) =>
  JSON.stringify({ schema_version: 1, command: "threads list", data });
const turn = JSON.stringify({
  schema_version: 1,
  command: "non-interactive",
  data: {
    status: "success",
    response: "NEMOCLAW_OTLP_DIRECT_RESPONSE_SENTINEL",
    completion: { thread_id: threadId },
  },
});

describe("observability probe conversation cleanup", () => {
  it("uses the exact native completion identity", () => {
    expect(observabilityProbeThreadId(turn)).toBe(threadId);
  });

  it.each([
    "not JSON",
    "null",
    JSON.stringify({ schema_version: 1, command: "threads list", data: {} }),
    JSON.stringify({
      schema_version: 1,
      command: "non-interactive",
      data: { completion: { thread_id: "--all" } },
    }),
    JSON.stringify({ schema_version: 1, command: "non-interactive", data: { completion: null } }),
  ])("refuses to select a conversation from invalid completion metadata (%s)", (output) => {
    expect(() => observabilityProbeThreadId(output)).toThrow();
  });

  it.each([
    [[], ""],
    [[{ thread_id: threadId, cwd: probeCwd }], threadId],
  ])("recovers only the exact privately owned cwd (%j)", (threads, expected) => {
    expect(observabilityProbeThreadId(nativeList(threads), probeCwd)).toBe(expected);
  });

  it.each([
    null,
    {},
    [null],
    [{ thread_id: threadId, cwd: `${probeCwd}-other` }],
    [{ thread_id: "--all", cwd: probeCwd }],
    [{ thread_id: threadId }],
    [
      { thread_id: threadId, cwd: probeCwd },
      { thread_id: threadId, cwd: probeCwd },
    ],
  ])("refuses ambiguous or out-of-scope native listings (%j)", (threads) => {
    expect(() => observabilityProbeThreadId(nativeList(threads), probeCwd)).toThrow();
  });

  it.each([
    [0, true, false, 0],
    [0, false, false, 0],
    [7, true, false, 0],
    [0, true, true, 0],
    [0, true, "before", 0],
    [0, false, "before", 0],
    [7, true, "before", 0],
    [0, true, false, 8],
    [0, true, "before", 8],
    [0, true, false, 0, true],
  ])(
    "cleans the exact probe on exit (%s, present=%s, interrupted=%s, rmdir=%s, completed=%s)",
    (nativeStatus, present, interrupted, directoryStatus, completed = false) => {
      const workspace = createHostProcessWorkspace("dcode-exit-cleanup-");
      const pidFile = workspace.path("collector.pid");
      onTestFinished(async () => {
        await cleanupExistingPath(pidFile, () =>
          terminateProcessIfRunning(Number(fs.readFileSync(pidFile, "utf8"))),
        );
        await cleanupExistingPath(workspace.path("capture-dir"), () =>
          fs.rmSync(fs.readFileSync(workspace.path("capture-dir"), "utf8").trim(), {
            recursive: true,
            force: true,
          }),
        );
        workspace.remove();
      });
      const fixtureFile = (relative: string, content = "") => {
        const target = workspace.path(relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        return target;
      };
      const command = (name: string, body: string) =>
        workspace.writeExecutable(name, `#!/bin/bash\nset -eu\n${body}`);
      fixtureFile(
        ".nemoclaw/sandboxes.json",
        JSON.stringify({
          sandboxes: { "test-sandbox": { observabilityEnabled: true } },
        }),
      );
      fixtureFile("test/e2e/live/deepagents-otlp-capture-server.ts");
      fixtureFile("test/e2e/live/deepagents-observability-contract.ts");
      fixtureFile("policy", "active\n");
      fixtureFile("control-thread", "unrelated conversation");
      fixtureFile(present ? "probe-thread" : "absent-thread", "synthetic probe");
      fixtureFile("turn.json", turn);
      const metadata = JSON.stringify({
        accepted: true,
        port: 4318,
        method: "POST",
        path: "/v1/traces",
      });
      fixtureFile("captures/allow.json", metadata);
      fixtureFile("captures/allow.body", "NEMOCLAW_OTLP_ALLOWED_PROBE");
      fixtureFile("captures/trace.json", metadata);
      fs.writeFileSync(
        workspace.path("captures/trace.body"),
        traceRequest([
          {
            name: "direct model",
            attributes: {
              "openinference.span.kind": "LLM",
              "input.value": "NEMOCLAW_OTLP_DIRECT_PROMPT_SENTINEL <redacted-secret>",
              "output.value": "NEMOCLAW_OTLP_DIRECT_RESPONSE_SENTINEL",
            },
          },
          {
            name: "login model",
            attributes: {
              "openinference.span.kind": "LLM",
              "input.value": "NEMOCLAW_OTLP_LOGIN_PROMPT_SENTINEL",
              "output.value": "NEMOCLAW_OTLP_LOGIN_RESPONSE_SENTINEL",
            },
          },
          {
            name: "tool",
            attributes: {
              "openinference.span.kind": "TOOL",
              "tool.name": "nemoclaw_otlp_e2e_tool",
              "tool.parameters": "NEMOCLAW_OTLP_TOOL_ARGUMENT_SENTINEL",
              "output.value": "NEMOCLAW_OTLP_TOOL_RESULT_SENTINEL",
            },
          },
        ]),
      );
      const tsx = command(
        "tsx",
        `case "$1" in
  *capture-server.ts)
    echo "$$" > "$CASE_ROOT/collector.pid"
    printf '%s\\n' "$2" > "$CASE_ROOT/capture-dir"
    echo CAPTURE_READY:
    exec /bin/sleep 300 ;;
  *) case "$2" in
    policy-state) cat ;;
    denial-state) cat >/dev/null; echo policy-denied ;;
    probe-thread-id|validate-captures) shift; exec "$REAL_TSX" "$REAL_HELPER" "$@" ;;
    *) exit 92 ;;
    esac ;;
esac`,
      );
      fs.mkdirSync(workspace.path("node_modules/.bin"), { recursive: true });
      fs.symlinkSync(tsx, workspace.path("node_modules/.bin/tsx"));
      command(
        "openshell",
        `case "$*" in
  *'getent ahostsv4'*) echo NEMOCLAW_OTLP_BIND_IP=192.168.1.2 ;;
  *'mkdir -m 0700 -- '*)
    printf '%s' "\${10}" > "$CASE_ROOT/probe-cwd-value"
    mkdir "$CASE_ROOT/probe-cwd" ;;
  *'dcode --json --timeout 90 -n'*)
    test "\${7#--chdir=}" = "$(cat "$CASE_ROOT/probe-cwd-value")"
    if [ "$INTERRUPT_TURN" != before ]; then cat "$CASE_ROOT/turn.json"; fi
    if [ "$INTERRUPT_TURN" != false ]; then
      kill -TERM "$(cat "$CASE_ROOT/check.pid")"
    fi
    if [ "$COMPLETED_TURN" = true ]; then exit 0; fi
    exit 7 ;;
  *NEMOCLAW_OTLP_LOGIN_RESPONSE_SENTINEL*) echo NEMOCLAW_OTLP_LOGIN_RESPONSE_SENTINEL ;;
  *'dcode threads list'*)
    test "\${10}" = "$(cat "$CASE_ROOT/probe-cwd-value")"
    if [ -f "$CASE_ROOT/probe-thread" ]; then
      printf '{"schema_version":1,"command":"threads list","data":[{"thread_id":"${threadId}","cwd":"%s"}]}\\n' "\${10}"
    else
      printf '%s\\n' '{"schema_version":1,"command":"threads list","data":[]}'
    fi ;;
  *'dcode threads delete'*)
    test "$9" = ${threadId}
    printf '%s\\n' "$9" > "$CASE_ROOT/deleted-thread"
    test "$NATIVE_STATUS" = 0 || exit "$NATIVE_STATUS"
    rm -f "$CASE_ROOT/probe-thread"
    ;;
  *'rmdir -- '*)
    test "$8" = "$(cat "$CASE_ROOT/probe-cwd-value")"
    test "$DIRECTORY_STATUS" = 0 || exit "$DIRECTORY_STATUS"
    rmdir "$CASE_ROOT/probe-cwd" ;;
  *'.nemoclaw-observability-enabled'*) echo 1 ;;
esac`,
      );
      const cli = command(
        "cli",
        `case "$2" in
  policy-list) cat "$CASE_ROOT/policy" ;;
  policy-add) echo active > "$CASE_ROOT/policy" ;;
  policy-remove) echo inactive > "$CASE_ROOT/policy" ;;
  exec) case "$*" in
    *NEMOCLAW_OTLP_TOOL_ARGUMENT_SENTINEL*)
      if [ "$(cat "$CASE_ROOT/policy")" = active ]; then
        cp "$CASE_ROOT"/captures/trace.* "$(cat "$CASE_ROOT/capture-dir")/"
      fi
      echo TOOL_TRACE_OK ;;
    *NEMOCLAW_OTLP_ALLOWED_PROBE*)
      cp "$CASE_ROOT"/captures/allow.* "$(cat "$CASE_ROOT/capture-dir")/"
      echo REACHED:200 ;;
    *) echo 'blocked by policy'; exit 7 ;;
    esac ;;
  *) exit 93 ;;
esac`,
      );
      command("ip", "echo '1: fixture inet 192.168.1.2/24'");
      command("curl", "exit 0");
      command("sleep", "exec /bin/sleep 0.02");
      command("timeout", 'shift 2; exec "$@"');
      const result = workspace.run(
        "bash",
        [
          "-c",
          'echo "$$" > "$CASE_ROOT/check.pid"; exec bash "$1"',
          "observability-check",
          path.resolve(
            "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
          ),
        ],
        {
          timeout: 30_000,
          env: {
            PATH: `${workspace.binDir}${path.delimiter}${process.env.PATH}`,
            HOME: workspace.homeDir,
            CASE_ROOT: workspace.root,
            REPO: workspace.root,
            SANDBOX_NAME: "test-sandbox",
            NEMOCLAW_CLI_BIN: cli,
            REAL_TSX: path.resolve("node_modules/.bin/tsx"),
            REAL_HELPER: path.resolve("test/e2e/live/deepagents-observability-contract.ts"),
            NATIVE_STATUS: String(nativeStatus),
            DIRECTORY_STATUS: String(directoryStatus),
            INTERRUPT_TURN: String(interrupted),
            COMPLETED_TURN: String(completed),
          },
        },
      );
      const cleanupFailed = nativeStatus !== 0 || directoryStatus !== 0;
      const expectedStatus = cleanupFailed ? 1 : interrupted ? 143 : completed ? 0 : 1;
      expect(result.status, result.output).toBe(expectedStatus);
      const deletion = workspace.path("deleted-thread");
      expect(fs.existsSync(deletion) ? fs.readFileSync(deletion, "utf8").trim() : "").toBe(
        interrupted === "before" && !present ? "" : threadId,
      );
      expect(fs.existsSync(workspace.path("probe-thread"))).toBe(present && nativeStatus !== 0);
      expect(fs.readFileSync(workspace.path("control-thread"), "utf8")).toBe(
        "unrelated conversation",
      );
      expect(fs.readFileSync(workspace.path("policy"), "utf8").trim()).toBe("active");
      expect(fs.existsSync(fs.readFileSync(workspace.path("capture-dir"), "utf8").trim())).toBe(
        false,
      );
      expect(result.stderr.includes("probe conversation cleanup failed")).toBe(cleanupFailed);
      expect(fs.existsSync(workspace.path("probe-cwd"))).toBe(cleanupFailed);
      const retainedCwd = fs.readFileSync(workspace.path("probe-cwd-value"), "utf8");
      expect(result.stderr.includes(`retained directory: ${retainedCwd}`)).toBe(cleanupFailed);
      expect(
        result.stderr.includes(
          `openshell sandbox exec --name test-sandbox -- dcode threads list --cwd ${retainedCwd} --limit 2 --json`,
        ),
      ).toBe(cleanupFailed);
      expect(
        result.stderr.includes(
          `openshell sandbox exec --name test-sandbox -- rmdir -- ${retainedCwd}`,
        ),
      ).toBe(cleanupFailed);
    },
  );
});
