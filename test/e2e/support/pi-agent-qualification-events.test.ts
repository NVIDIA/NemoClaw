// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { directDockerfileContextSources } from "../../../scripts/lib/dockerfile-copy-sources.mts";
import { DEFAULT_CLOUD_MODEL } from "../../../src/lib/inference/config.ts";
import { runBoundedRetry } from "../../../tools/e2e/retry-evidence.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

import {
  buildPiReadTask,
  classifyPiReadTaskAttempt,
  hasCompletedPiTurn,
  isTransientPiInferenceFailure,
  parsePiJsonEvents,
  parsePiInferenceEvidence,
  PiInferenceFailure,
  qualifyPiReadTask,
} from "../live/pi-agent-qualification-events.ts";

const PATH = "/sandbox/pi-qualification.txt";
const TOKEN = "NEMOCLAW_PI_TASK_V1_0123456789ABCDEF";

function eventStream(overrides: Record<string, unknown> = {}): string {
  return [
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: PATH },
      ...overrides,
    },
    {
      type: "tool_execution_end",
      toolCallId: "call-read",
      toolName: "read",
      result: { content: TOKEN },
      isError: false,
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: TOKEN }] },
    },
    { type: "agent_end", messages: [], willRetry: false },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

function events(...values: Record<string, unknown>[]): string {
  return values.map((event) => JSON.stringify(event)).join("\n");
}

function runReadTaskSeed(root: string, seedScript: string) {
  const script = path.join(root, "seed.sh");
  fs.writeFileSync(script, `sync() { :; }\n${seedScript}`);
  return spawnSync("bash", ["--noprofile", "--norc", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, BASH_ENV: "", ENV: "" },
    timeout: 2_000,
    killSignal: "SIGKILL",
  });
}

describe("Pi qualification task construction", () => {
  it.each(["before-rebuild", "after-rebuild", "after-recovery"])(
    "constructs a context-free headless read for %s",
    (phase) => {
      const taskName = `pi-read-v3-${phase}`;
      const task = buildPiReadTask("pi-qual", "/sandbox/task root/workspace", taskName, TOKEN);

      expect(task.remotePath).toBe("/sandbox/task root/workspace/task.txt");
      expect(task.argv).toEqual([
        "pi-qual",
        "exec",
        "--workdir",
        "/sandbox/task root/workspace",
        "--no-tty",
        "--timeout",
        "300",
        "--",
        "pi",
        "--no-approve",
        "--no-context-files",
        "--mode",
        "json",
        "--print",
        "--tools",
        "read",
        "--name",
        taskName,
        "Use the read tool exactly once to read /sandbox/task root/workspace/task.txt. Reply with exactly the file contents as plain text. Do not add Markdown, code fences, backticks, explanations, or any other text.",
      ]);
    },
  );

  it("seeds quoted task contents and both private context files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-read-task-"));
    const workdir = path.join(root, "workspace 'quoted'");
    const token = "literal 'quotes' and $HOME";

    try {
      const task = buildPiReadTask("pi-qual", workdir, "pi-read-v3-before-rebuild", token);
      const result = runReadTaskSeed(root, task.seedScript);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(task.remotePath, "utf8")).toBe(`${token}\n`);
      const parentContext = path.join(root, "AGENTS.md");
      const projectContext = path.join(workdir, "CLAUDE.md");
      const context = fs.readFileSync(parentContext, "utf8");
      expect(context).toContain("NEMOCLAW_PI_UNTRUSTED_CONTEXT");
      expect(fs.readFileSync(projectContext, "utf8")).toBe(context);
      expect(fs.statSync(task.remotePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(parentContext).mode & 0o777).toBe(0o600);
      expect(fs.statSync(projectContext).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops seeding when the workspace cannot be created", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-read-task-"));
    const workdir = path.join(root, "workspace");

    try {
      fs.writeFileSync(workdir, "occupied");
      const task = buildPiReadTask("pi-qual", workdir, "pi-read-v3-before-rebuild", TOKEN);
      const result = runReadTaskSeed(root, task.seedScript);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(workdir, "utf8")).toBe("occupied");
      expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function failedProbe(): ShellProbeResult {
  return {
    command: ["pi"],
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}
describe("Pi qualification event oracle", () => {
  it.each([
    ["pending Pi turn", ""],
    ["truncated final event", '\n{"type":"message_update","message":{"role":"assistant"}'],
  ])("retries a timed-out %s once and records both attempts (#13755)", async (_label, suffix) => {
    const pendingEvents = parsePiJsonEvents(
      events({ type: "agent_start" }, { type: "message_start", message: { role: "assistant" } }) +
        suffix,
      { allowTruncatedFinalLine: true },
    );
    let failure: unknown;
    try {
      qualifyPiReadTask(pendingEvents, PATH, TOKEN);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(hasCompletedPiTurn(pendingEvents)).toBe(false);
    const proof = qualifyPiReadTask(parsePiJsonEvents(eventStream()), PATH, TOKEN);
    const attempts: number[] = [];
    const execution = await runBoundedRetry({
      operation: "pi-agent-qualification.read-after-recovery",
      owner: "inference-provider",
      idempotence: "read-only",
      maxAttempts: 2,
      run: async (attempt) => {
        attempts.push(attempt);
        return attempt === 1
          ? {
              failure,
              proof: undefined,
              result: { ...failedProbe(), exitCode: 143, timedOut: true },
              turnCompleted: false,
            }
          : {
              failure: undefined,
              proof,
              result: { ...failedProbe(), exitCode: 0 },
              turnCompleted: true,
            };
      },
      classify: classifyPiReadTaskAttempt,
    });

    expect(attempts).toEqual([1, 2]);
    expect(execution.evidence).toMatchObject({
      outcome: "passed-after-retry",
      attempts: [
        { failureClass: "transient-external", retryScheduled: true },
        { outcome: "passed", retryScheduled: false },
      ],
    });
    expect(
      classifyPiReadTaskAttempt(
        {
          failure: undefined,
          proof,
          result: { ...failedProbe(), exitCode: 0, timedOut: true },
          turnCompleted: true,
        },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
  });

  it("keeps completed and malformed final Pi events strict on timeout (#13755)", () => {
    const completeEvents = eventStream();
    const truncated = `${completeEvents}\n{"type":"message_update","message":{"role":"assistant"}`;
    const parsed = parsePiJsonEvents(truncated, { allowTruncatedFinalLine: true });
    expect(hasCompletedPiTurn(parsed)).toBe(true);
    expect(qualifyPiReadTask(parsed, PATH, TOKEN)).toBeDefined();
    expect(() => parsePiJsonEvents(truncated)).toThrow();
    expect(() => parsePiJsonEvents(`${truncated}\n`, { allowTruncatedFinalLine: true })).toThrow();
    expect(() =>
      parsePiJsonEvents(`${completeEvents}\n{"type":bogus}`, {
        allowTruncatedFinalLine: true,
      }),
    ).toThrow();
  });

  it("accepts a truncated final event with whitespace after its type key (#13755)", () => {
    const prefix = events({ type: "agent_start" });
    expect(
      parsePiJsonEvents(`${prefix}\n{"type": "message_update", "message":`, {
        allowTruncatedFinalLine: true,
      }),
    ).toEqual([{ type: "agent_start" }]);
  });

  it("retries a timed-out valid read and reply awaiting agent_end (#13755)", async () => {
    const partialEvents = parsePiJsonEvents(eventStream().split("\n").slice(0, -1).join("\n"));
    const proof = qualifyPiReadTask(partialEvents, PATH, TOKEN);
    expect(hasCompletedPiTurn(partialEvents)).toBe(false);

    const attempts: number[] = [];
    const execution = await runBoundedRetry({
      operation: "pi-agent-qualification.read-after-recovery",
      owner: "inference-provider",
      idempotence: "read-only",
      maxAttempts: 2,
      run: async (attempt) => {
        attempts.push(attempt);
        return {
          failure: undefined,
          proof,
          result: { ...failedProbe(), exitCode: attempt === 1 ? 143 : 0, timedOut: attempt === 1 },
          turnCompleted: attempt === 2,
        };
      },
      classify: classifyPiReadTaskAttempt,
    });

    expect(attempts).toEqual([1, 2]);
    expect(execution.evidence).toMatchObject({
      outcome: "passed-after-retry",
      attempts: [
        { failureClass: "transient-external", retryScheduled: true },
        { outcome: "passed", retryScheduled: false },
      ],
    });
  });

  it.each(['{"type":bogus', '{"type":true,"message":', '{"type":"message_update","message":bogus'])(
    "does not retry a malformed timed-out final event %s (#13755)",
    async (malformedFinalLine) => {
      const stdout = `${events({ type: "agent_start" })}\n${malformedFinalLine}`;
      const attempts: number[] = [];
      const execution = await runBoundedRetry({
        operation: "pi-agent-qualification.read-after-recovery",
        owner: "inference-provider",
        idempotence: "read-only",
        maxAttempts: 2,
        run: async (attempt) => {
          attempts.push(attempt);
          let failure: unknown;
          try {
            parsePiJsonEvents(stdout, { allowTruncatedFinalLine: true });
          } catch (error) {
            failure = error;
          }
          return {
            failure,
            proof: undefined,
            result: { ...failedProbe(), exitCode: 143, timedOut: true },
            turnCompleted: false,
          };
        },
        classify: classifyPiReadTaskAttempt,
      });
      expect(attempts).toEqual([1]);
      expect(execution.evidence).toMatchObject({
        outcome: "failed-no-retry",
        attempts: [{ failureClass: "deterministic", retryScheduled: false }],
      });
    },
  );

  it.each([
    ["disallowed tool", { toolName: "bash" }],
    ["wrong read path", { args: { path: "/sandbox/other" } }],
  ])("does not retry a timed-out partial stream with a %s (#13755)", async (_label, override) => {
    const partialEvents = parsePiJsonEvents(
      events(
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "call-read",
          toolName: "read",
          args: { path: PATH },
          ...override,
        },
      ) + '\n{"type":"message_update","message":{"role":"assistant"}',
      { allowTruncatedFinalLine: true },
    );
    let failure: unknown;
    try {
      qualifyPiReadTask(partialEvents, PATH, TOKEN);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(hasCompletedPiTurn(partialEvents)).toBe(false);

    const attempts: number[] = [];
    const execution = await runBoundedRetry({
      operation: "pi-agent-qualification.read-after-recovery",
      owner: "inference-provider",
      idempotence: "read-only",
      maxAttempts: 2,
      run: async (attempt) => {
        attempts.push(attempt);
        return {
          failure,
          proof: undefined,
          result: { ...failedProbe(), exitCode: 143, timedOut: true },
          turnCompleted: false,
        };
      },
      classify: classifyPiReadTaskAttempt,
    });
    expect(attempts).toEqual([1]);
    expect(execution.evidence).toMatchObject({
      outcome: "failed-no-retry",
      attempts: [{ failureClass: "deterministic", retryScheduled: false }],
    });
  });

  it("does not retry a completed Pi response without a read call (#13755)", async () => {
    const completedEvents = parsePiJsonEvents(
      events(
        { type: "agent_start" },
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: TOKEN }] },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ),
    );
    let failure: unknown;
    try {
      qualifyPiReadTask(completedEvents, PATH, TOKEN);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(hasCompletedPiTurn(completedEvents)).toBe(true);

    expect(
      classifyPiReadTaskAttempt(
        {
          failure,
          proof: undefined,
          result: { ...failedProbe(), exitCode: 0 },
          turnCompleted: true,
        },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    expect(
      classifyPiReadTaskAttempt(
        {
          failure,
          proof: undefined,
          result: { ...failedProbe(), exitCode: 143, timedOut: true },
          turnCompleted: true,
        },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    const attempts: number[] = [];
    const execution = await runBoundedRetry({
      operation: "pi-agent-qualification.read-after-recovery",
      owner: "inference-provider",
      idempotence: "read-only",
      maxAttempts: 2,
      run: async (attempt) => {
        attempts.push(attempt);
        return {
          failure,
          proof: undefined,
          result: { ...failedProbe(), exitCode: 143, timedOut: true },
          turnCompleted: hasCompletedPiTurn(completedEvents),
        };
      },
      classify: classifyPiReadTaskAttempt,
    });
    expect(attempts).toEqual([1]);
    expect(execution.evidence).toMatchObject({
      outcome: "failed-no-retry",
      attempts: [{ failureClass: "deterministic", retryScheduled: false }],
    });
  });

  it("keeps every Pi image source in the AMD64 lifecycle target ownership boundary (#7926)", () => {
    const imageSources = new Set<string>([
      ".dockerignore",
      ...["agents/pi/Dockerfile", "agents/pi/Dockerfile.base"].flatMap((dockerfile) =>
        directDockerfileContextSources(path.join(REPO_ROOT, dockerfile), dockerfile).map(
          ({ source }) => source,
        ),
      ),
    ]);
    const uncovered = [...imageSources].filter(
      (source) =>
        !catalogueTargetsForChangedFiles([source]).some(
          (target) => target.id === "pi-agent-qualification-amd64",
        ),
    );

    expect(uncovered, "the AMD64 lifecycle target must own every Pi Docker COPY input").toEqual([]);
  });

  it("selects only AMD64 lifecycle qualification for a copied Pi image source (#7926)", () => {
    const targetIds = catalogueTargetsForChangedFiles([
      "nemoclaw-blueprint/scripts/nemotron-inference-fix.js",
    ]).map((target) => target.id);

    expect(targetIds).toContain("pi-agent-qualification-amd64");
    expect(targetIds).not.toContain("pi-agent-qualification-arm64");
  });

  it("qualifies the AMD64 target against public Super VL", () => {
    expect(DEFAULT_CLOUD_MODEL).toBe("nvidia/nemotron-3.5-super-vl-120b-a12b");
    expect(catalogueTarget("pi-agent-qualification-amd64").environment).toMatchObject({
      NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia",
      NEMOCLAW_MODEL: DEFAULT_CLOUD_MODEL,
    });
    const config = (model: string) =>
      JSON.stringify({
        providers: {
          openshell: {
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            models: [{ id: model }],
          },
        },
      });
    expect(parsePiInferenceEvidence(config(DEFAULT_CLOUD_MODEL), DEFAULT_CLOUD_MODEL).model).toBe(
      DEFAULT_CLOUD_MODEL,
    );
    expect(() =>
      parsePiInferenceEvidence(config("nvidia/nemotron-3-super-120b-a12b"), DEFAULT_CLOUD_MODEL),
    ).toThrow("does not match the qualified route");
  });

  it("accepts one successful read and an exact final response", () => {
    const events = parsePiJsonEvents(eventStream());

    expect(qualifyPiReadTask(events, PATH, TOKEN)).toEqual({
      assistantText: TOKEN,
      eventCount: 5,
      toolCallId: "call-read",
    });
  });

  it("rejects the observed trailing Markdown fence without retrying (#13364)", () => {
    const recordedReply = `${TOKEN}\n\`\`\``;
    const stream = parsePiJsonEvents(eventStream());
    stream[3] = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: recordedReply }],
      },
    };
    let failure: unknown;
    try {
      qualifyPiReadTask(stream, PATH, TOKEN);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("instead of exact file contents");
    expect(hasCompletedPiTurn(stream)).toBe(true);
    expect(
      classifyPiReadTaskAttempt(
        {
          failure,
          proof: undefined,
          result: { ...failedProbe(), exitCode: 0 },
          turnCompleted: true,
        },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    expect(
      classifyPiReadTaskAttempt(
        {
          failure,
          proof: undefined,
          result: { ...failedProbe(), exitCode: 143, timedOut: true },
          turnCompleted: true,
        },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
  });

  it("rejects malformed JSON, another tool, a failed read, and altered output", () => {
    expect(() => parsePiJsonEvents("not-json\n")).toThrow();
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(eventStream({ toolName: "bash" })), PATH, TOKEN),
    ).toThrow("exact read tool call");
    expect(() =>
      qualifyPiReadTask(
        parsePiJsonEvents(eventStream().replace('"isError":false', '"isError":true')),
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() => qualifyPiReadTask(parsePiJsonEvents(eventStream()), PATH, `${TOKEN}X`)).toThrow(
      "instead of exact file contents",
    );
  });

  it.each(["HTTP 503: Service Unavailable", "Service temporarily overloaded"])(
    "classifies a Pi provider error as transient: %s",
    (errorMessage) => {
      const providerError = {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage,
        },
      };
      const valid = parsePiJsonEvents(eventStream());
      const exhaustedRetries = valid.flatMap((event) =>
        event.type === "message_end" ? Array.from({ length: 4 }, () => providerError) : [event],
      );
      let failure: unknown;
      try {
        qualifyPiReadTask(exhaustedRetries, PATH, TOKEN);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(PiInferenceFailure);
      expect((failure as Error).message).toBe(`Pi inference failed: ${errorMessage}`);
      expect(isTransientPiInferenceFailure(failure)).toBe(true);
    },
  );

  it("retries a transient provider error before the read tool starts (#11761)", () => {
    const eventValues = parsePiJsonEvents(
      events(
        { type: "agent_start" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "HTTP 503: Service Unavailable",
          },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ),
    );
    let failure: unknown;
    try {
      qualifyPiReadTask(eventValues, PATH, TOKEN);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PiInferenceFailure);
    expect(
      classifyPiReadTaskAttempt(
        { failure, proof: undefined, result: failedProbe(), turnCompleted: true },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "transient-external" });
    expect(
      classifyPiReadTaskAttempt(
        {
          failure,
          proof: undefined,
          result: { ...failedProbe(), exitCode: 143, timedOut: true },
          turnCompleted: hasCompletedPiTurn(eventValues),
        },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "transient-external" });
  });

  it("accepts a valid Pi response after an earlier provider error", () => {
    const providerError = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Service temporarily overloaded",
      },
    };
    const valid = parsePiJsonEvents(eventStream());
    const recoveredRetry = valid.flatMap((event) =>
      event.type === "message_end" ? [providerError, event] : [event],
    );
    expect(qualifyPiReadTask(recoveredRetry, PATH, TOKEN).assistantText).toBe(TOKEN);
  });

  it("retries a transient provider error after an assistant response (#11761)", () => {
    const providerError = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "HTTP 503: Service Unavailable",
      },
    };
    const valid = parsePiJsonEvents(eventStream());
    const failedAfterReply = valid.flatMap((event) =>
      event.type === "message_end" ? [event, providerError] : [event],
    );
    let failure: unknown;
    try {
      qualifyPiReadTask(failedAfterReply, PATH, TOKEN);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PiInferenceFailure);
    expect(
      classifyPiReadTaskAttempt(
        { failure, proof: undefined, result: failedProbe(), turnCompleted: true },
        undefined,
      ),
    ).toEqual({ outcome: "failed", failureClass: "transient-external" });
  });

  it.each(["authentication failed", "HTTP 400: invalid request", "HTTP 501: unsupported"])(
    "does not classify a deterministic Pi provider error as transient: %s",
    (errorMessage) => {
      expect(
        isTransientPiInferenceFailure(
          new PiInferenceFailure(`Pi inference failed: ${errorMessage}`),
        ),
      ).toBe(false);
    },
  );

  it("redacts and bounds a provider error diagnostic (#11761)", () => {
    const diagnosticPrefix = "Pi inference failed: ";
    const providerError = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: `HTTP 503 for nvapi-secret-value-0123456789 ${"x".repeat(500)}`,
      },
    };
    const valid = parsePiJsonEvents(eventStream());
    const failed = valid.flatMap((event) =>
      event.type === "message_end" ? [providerError] : [event],
    );

    let failure: unknown;
    try {
      qualifyPiReadTask(failed, PATH, TOKEN);
    } catch (error) {
      failure = error;
    }
    const message = (failure as Error).message;

    expect(failure).toBeInstanceOf(PiInferenceFailure);
    expect(message).toContain("HTTP 503");
    expect(message).not.toMatch(/nvapi-secret/iu);
    expect(message.length).toBeLessThanOrEqual(diagnosticPrefix.length + 200);
  });

  it("rejects missing, extra, or mismatched read events", () => {
    const valid = parsePiJsonEvents(eventStream());
    expect(() =>
      qualifyPiReadTask(
        valid.filter((event) => event.type !== "tool_execution_end"),
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask([...valid, { ...valid[1], toolCallId: "second-read" }], PATH, TOKEN),
    ).toThrow("must start exactly one tool");
    expect(() =>
      qualifyPiReadTask(
        [...valid, { ...valid[2], toolCallId: "unmatched-completion" }],
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask(
        parsePiJsonEvents(eventStream({ args: { path: "/sandbox/other" } })),
        PATH,
        TOKEN,
      ),
    ).toThrow("exact read tool call");
  });

  it("rejects an early or duplicate completion for the read call", () => {
    const start = {
      type: "tool_execution_start",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: PATH },
    };
    const success = {
      type: "tool_execution_end",
      toolCallId: "call-read",
      toolName: "read",
      result: { content: TOKEN },
      isError: false,
    };
    const failure = { ...success, isError: true };
    const reply = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: TOKEN }] },
    };

    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(success, start, failure, reply)), PATH, TOKEN),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(start, success, success, reply)), PATH, TOKEN),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(start, reply, success)), PATH, TOKEN),
    ).toThrow("after the read completed");
  });

  it("accepts the native NVIDIA route used by Pi qualification", () => {
    expect(
      parsePiInferenceEvidence(
        JSON.stringify({
          providers: {
            openshell: {
              api: "openai-completions",
              baseUrl: "https://integrate.api.nvidia.com/v1",
              models: [{ id: "nvidia/test-model" }],
            },
          },
        }),
        "nvidia/test-model",
      ),
    ).toEqual({
      api: "openai-completions",
      model: "nvidia/test-model",
      route: "https://integrate.api.nvidia.com/v1",
    });
  });

  it.each([
    ["https://inference.local/v1", "nvidia/test-model"],
    ["https://integrate.api.nvidia.com/v1", "nvidia/other-model"],
  ])("rejects a mismatched route %s or model %s", (baseUrl, model) => {
    expect(() => parsePiInferenceEvidence("{}", "nvidia/test-model")).toThrow(
      "Pi managed inference providers must be an object",
    );
    expect(() =>
      parsePiInferenceEvidence(
        JSON.stringify({
          providers: {
            openshell: {
              api: "openai-completions",
              baseUrl,
              models: [{ id: model }],
            },
          },
        }),
        "nvidia/test-model",
      ),
    ).toThrow("does not match the qualified route");
  });
});
