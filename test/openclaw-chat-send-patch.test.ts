// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-chat-send.js",
);

function writeChatSendFixture(dist: string): string {
  const fixture = path.join(dist, "chat-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const chatHandlers = {',
      '  "chat.send": async ({ params, respond, context, client }) => {',
      "    const p = params;",
      "    const clientRunId = p.idempotencyKey;",
      '    const sessionKey = "issue2603";',
      "    let agentRunStarted = false;",
      "    measureDiagnosticsTimelineSpan(\"gateway.chat_send.dispatch_inbound\", () => dispatchInboundMessage({",
      "      replyOptions: {",
      "        runId: clientRunId,",
      "        onAgentRunStart: (runId) => {",
      "          agentRunStarted = true;",
      "          if (!hasBeforeAgentRunGate) emitUserTranscriptUpdate();",
      "        }",
      "      }",
      "    })).then(async () => {",
      "      if (!agentRunStarted) {",
      "        let message;",
      "        if (transcriptReply || persistedContentForAppend?.length || assistantContent?.length) {",
      "          const appended = await appendAssistantTranscriptMessage({",
      "            message: transcriptReply,",
      "            sessionId,",
      "            storePath: latestStorePath,",
      "            sessionFile: latestEntry?.sessionFile,",
      "            agentId,",
      "            createIfMissing: true,",
      "            ttsSupplement: ttsSupplementMarker,",
      "            cfg",
      "          });",
      "          message = appended.message;",
      "        }",
      "        broadcastChatFinal({",
      "          context,",
      "          runId: clientRunId,",
      "          sessionKey,",
      "          message",
      "        });",
      "      }",
      "    });",
      "  }",
      "};",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeFollowupRunnerFixture(dist: string): string {
  const fixture = path.join(dist, "agent-runner.fixture.js");
  fs.writeFileSync(
    fixture,
    [
      "function createFollowupRunner(params) {",
      "  return async function runQueuedFollowup(queued, opts, run) {",
      "    let replyOperation;",
      "    replyOperation = createReplyOperation({",
      "      sessionId: run.sessionId,",
      '      sessionKey: replySessionKey ?? "",',
      "      resetTriggered: false,",
      "      upstreamAbortSignal: queued.abortSignal ?? opts?.abortSignal",
      "    });",
      "    const runId = crypto.randomUUID();",
      "    if (run.sessionKey) registerAgentRunContext(runId, {",
      "      sessionKey: run.sessionKey,",
      "      verboseLevel: run.verboseLevel",
      "    });",
      "    return runId;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeFollowupRunner20260522Fixture(dist: string): string {
  const fixture = path.join(dist, "agent-runner.fixture.js");
  fs.writeFileSync(
    fixture,
    [
      "function createFollowupRunner(params) {",
      "  const { opts, typing, sessionEntry } = params;",
      "  return async (queued) => {",
      "    let replyOperation;",
      "    let run = queued.run;",
      "    replyOperation = createReplyOperation({",
      "      sessionId: run.sessionId,",
      '      sessionKey: replySessionKey ?? "",',
      "      resetTriggered: false,",
      "      upstreamAbortSignal: queued.abortSignal",
      "    });",
      "    const runId = crypto.randomUUID();",
      "    if (run.sessionKey) registerAgentRunContext(runId, {",
      "      sessionKey: run.sessionKey,",
      "      verboseLevel: run.verboseLevel",
      "    });",
      "    return runId;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeFollowupRunner20260527Fixture(dist: string): string {
  const fixture = path.join(dist, "agent-runner.fixture.js");
  fs.writeFileSync(
    fixture,
    [
      "function createFollowupRunner(params) {",
      "  const { opts, typing, sessionEntry } = params;",
      "  return async (queued) => {",
      "    let replyOperation;",
      "    let run = queued.run;",
      "    const replySessionKey = queued.run.sessionKey ?? sessionKey;",
      "    const admission = await admitReplyTurn({",
      "      sessionId: run.sessionId,",
      '      sessionKey: replySessionKey ?? "",',
      '      kind: "queued_followup",',
      "      resetTriggered: false,",
      "      upstreamAbortSignal: queued.abortSignal",
      "    });",
      '    if (admission.status === "skipped") return;',
      "    replyOperation = admission.operation;",
      "    if (replyOperation.sessionId !== run.sessionId) {",
      "      run = { ...run, sessionId: replyOperation.sessionId };",
      "    }",
      "    const runId = crypto.randomUUID();",
      "    if (run.sessionKey) registerAgentRunContext(runId, {",
      "      sessionKey: run.sessionKey,",
      "      verboseLevel: run.verboseLevel",
      "    });",
      "    return runId;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeFollowupRunnerWithoutOptsBindingFixture(dist: string): string {
  const fixture = path.join(dist, "agent-runner.fixture.js");
  fs.writeFileSync(
    fixture,
    [
      "function createFollowupRunner(params) {",
      "  return async (queued) => {",
      "    let replyOperation;",
      "    let run = queued.run;",
      "    replyOperation = createReplyOperation({",
      "      sessionId: run.sessionId,",
      '      sessionKey: replySessionKey ?? "",',
      "      resetTriggered: false,",
      "      upstreamAbortSignal: queued.abortSignal",
      "    });",
      "    const runId = crypto.randomUUID();",
      "    if (run.sessionKey) registerAgentRunContext(runId, {",
      "      sessionKey: run.sessionKey,",
      "      verboseLevel: run.verboseLevel",
      "    });",
      "    return runId;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeGetReplyFixture(dist: string): string {
  const fixture = path.join(dist, "get-reply.fixture.js");
  fs.writeFileSync(
    fixture,
    [
      "async function getReplyFromConfig(params) {",
      "  const { cfg, opts, sessionCtx, sessionEntry, perMessageQueueMode, perMessageQueueOptions } = params;",
      "  const resolvedQueue = useFastReplyRuntime ? {",
      '    mode: "collect",',
      "    debounceMs: 0,",
      "    cap: 1,",
      '    dropPolicy: "summarize"',
      "  } : resolveQueueSettings({",
      "    cfg,",
      "    channel: sessionCtx.Provider,",
      "    sessionEntry,",
      "    inlineMode: perMessageQueueMode,",
      "    inlineOptions: perMessageQueueOptions",
      "  });",
      '  const piRuntime = useFastReplyRuntime ? null : await traceRunPhase("reply.load_pi_runtime", () => loadPiEmbeddedRuntime());',
      "  const followupRun = {",
      "    prompt: queuedBody,",
      "    transcriptPrompt: transcriptCommandBody,",
      "    currentInboundEventKind: inboundEventKind,",
      "    currentInboundContext,",
      "    abortSignal: opts?.abortSignal,",
      "    run: { sessionId: preparedSessionState.sessionId }",
      "  };",
      "  return { resolvedQueue, piRuntime, followupRun };",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function runPatch(dist: string) {
  return spawnSync(process.execPath, [PATCH_SCRIPT, dist], {
    encoding: "utf-8",
    timeout: 10000,
  });
}

type FollowupQueuedFixture = {
  runId?: string;
  abortSignal?: AbortSignal;
  run: { sessionId: string; sessionKey: string };
};

async function runPatchedFollowupFixture(
  patchedSource: string,
  params: { opts?: { runId?: string } },
  queued: FollowupQueuedFixture,
) {
  const registeredRuns: string[] = [];
  const context = {
    createReplyOperation: (value: unknown) => value,
    crypto: { randomUUID: () => "fallback-run-id" },
    admitReplyTurn: async () => ({ status: "admitted", operation: { sessionId: "session" } }),
    registerAgentRunContext: (runId: string) => registeredRuns.push(runId),
    replySessionKey: "reply-session",
    sessionKey: "fallback-session-key",
  };
  const createFollowupRunner = vm.runInNewContext(
    `${patchedSource}\ncreateFollowupRunner;`,
    context,
  ) as (params: { opts?: { runId?: string } }) => (
    queued: FollowupQueuedFixture,
  ) => Promise<string>;

  const runId = await createFollowupRunner(params)(queued);
  return { registeredRuns, runId };
}

describe("OpenClaw chat.send compatibility patch", () => {
  it("correlates agent runs, idempotently appends transcripts, and suppresses empty finals", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-chat-send-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    const chatFixture = writeChatSendFixture(dist);
    const followupFixture = writeFollowupRunnerFixture(dist);
    const getReplyFixture = writeGetReplyFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("patched OpenClaw chat.send compatibility");

      const patched = fs.readFileSync(chatFixture, "utf-8");
      expect(patched).toContain(
        "context.addChatRun(runId, { sessionKey, clientRunId }); // nemoclaw: correlate chat.send run ids (#2603, #3145)",
      );
      expect(patched).toContain("idempotencyKey: clientRunId");
      expect(patched).toContain("if (message) broadcastChatFinal({");
      expect(patched).toContain("suppressing empty final event");

      const patchedFollowup = fs.readFileSync(followupFixture, "utf-8");
      expect(patchedFollowup).toContain(
        "const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue (#2603, #3145)",
      );
      const patchedGetReply = fs.readFileSync(getReplyFixture, "utf-8");
      expect(patchedGetReply).toContain(
        "runId: opts?.runId, // nemoclaw: carry chat.send run id into queued followup (#2603, #3145)",
      );
      expect(patchedGetReply).toContain(
        'if (opts?.runId && sessionCtx.Provider === "webchat" && resolvedQueue.mode === "steer") resolvedQueue = {',
      );
      expect(patchedGetReply).toContain(
        "}; // nemoclaw: force webchat chat.send queued turns to keep per-message replies (#2603, #3145)",
      );

      const rerun = runPatch(dist);
      expect(rerun.status, `${rerun.stdout}${rerun.stderr}`).toBe(0);
      const rerunPatched = fs.readFileSync(chatFixture, "utf-8");
      expect(rerunPatched.match(/context\.addChatRun\(runId/g)).toHaveLength(1);
      expect(rerunPatched.match(/idempotencyKey: clientRunId/g)).toHaveLength(1);
      expect(rerunPatched.match(/suppressing empty final event/g)).toHaveLength(1);
      const rerunPatchedFollowup = fs.readFileSync(followupFixture, "utf-8");
      expect(rerunPatchedFollowup.match(/preserve chat\.send run ids in followup queue/g)).toHaveLength(
        1,
      );
      const rerunPatchedGetReply = fs.readFileSync(getReplyFixture, "utf-8");
      expect(rerunPatchedGetReply.match(/carry chat\.send run id into queued followup/g)).toHaveLength(
        1,
      );
      expect(rerunPatchedGetReply.match(/force webchat chat\.send queued turns/g)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("recognizes the 2026.5.22 followup runner abort-signal shape", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-chat-send-522-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeChatSendFixture(dist);
    const followupFixture = writeFollowupRunner20260522Fixture(dist);
    writeGetReplyFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      const patchedFollowup = fs.readFileSync(followupFixture, "utf-8");
      expect(patchedFollowup).toContain(
        "const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue (#2603, #3145)",
      );
      await expect(
        runPatchedFollowupFixture(
          patchedFollowup,
          { opts: { runId: "opts-run-id" } },
          { runId: "queued-run-id", run: { sessionId: "session", sessionKey: "key" } },
        ),
      ).resolves.toMatchObject({ runId: "queued-run-id", registeredRuns: ["queued-run-id"] });
      await expect(
        runPatchedFollowupFixture(
          patchedFollowup,
          { opts: { runId: "opts-run-id" } },
          { run: { sessionId: "session", sessionKey: "key" } },
        ),
      ).resolves.toMatchObject({ runId: "opts-run-id", registeredRuns: ["opts-run-id"] });
      await expect(
        runPatchedFollowupFixture(
          patchedFollowup,
          {},
          { run: { sessionId: "session", sessionKey: "key" } },
        ),
      ).resolves.toMatchObject({ runId: "fallback-run-id", registeredRuns: ["fallback-run-id"] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("recognizes the 2026.5.27 followup runner admission shape", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-chat-send-527-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeChatSendFixture(dist);
    const followupFixture = writeFollowupRunner20260527Fixture(dist);
    writeGetReplyFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      const patchedFollowup = fs.readFileSync(followupFixture, "utf-8");
      expect(patchedFollowup).toContain(
        "const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue (#2603, #3145)",
      );
      await expect(
        runPatchedFollowupFixture(
          patchedFollowup,
          { opts: { runId: "opts-run-id" } },
          { runId: "queued-run-id", run: { sessionId: "session", sessionKey: "key" } },
        ),
      ).resolves.toMatchObject({ runId: "queued-run-id", registeredRuns: ["queued-run-id"] });
      await expect(
        runPatchedFollowupFixture(
          patchedFollowup,
          { opts: { runId: "opts-run-id" } },
          { run: { sessionId: "session", sessionKey: "key" } },
        ),
      ).resolves.toMatchObject({ runId: "opts-run-id", registeredRuns: ["opts-run-id"] });
      await expect(
        runPatchedFollowupFixture(
          patchedFollowup,
          {},
          { run: { sessionId: "session", sessionKey: "key" } },
        ),
      ).resolves.toMatchObject({ runId: "fallback-run-id", registeredRuns: ["fallback-run-id"] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the followup runner opts binding is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-chat-send-no-opts-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeChatSendFixture(dist);
    writeFollowupRunnerWithoutOptsBindingFixture(dist);
    writeGetReplyFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("OpenClaw followup runner opts binding not recognized");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the OpenClaw chat.send source shape changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-chat-send-missing-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "chat-fixture.js"), 'const handlers = { "chat.send": true };\n');

    try {
      const patch = runPatch(dist);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("expected exactly one OpenClaw chat.send runtime file");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
