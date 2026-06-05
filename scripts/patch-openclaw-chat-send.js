#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary NemoClaw compatibility shim for OpenClaw 2026.5.x chat.send
 * gateway behavior. Remove this when upstream OpenClaw preserves submitted
 * chat.send run lineage and stops emitting empty terminal chat events.
 */

const fs = require("node:fs");
const path = require("node:path");

const distDir = process.argv[2];
if (!distDir) {
  console.error("Usage: patch-openclaw-chat-send.js <openclaw-dist-dir>");
  process.exit(2);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function listJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(dir, entry.name));
}

function patchChatSendFile(file) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;

  if (!source.includes("nemoclaw: correlate chat.send run ids")) {
    const next = source.replace(
      /(onAgentRunStart: \(runId\) => \{\n)(\s*)agentRunStarted = true;/,
      (_match, prefix, indent) =>
        `${prefix}${indent}agentRunStarted = true;\n` +
        `${indent}if (runId && runId !== clientRunId) context.addChatRun(runId, { sessionKey, clientRunId }); ` +
        `// nemoclaw: correlate chat.send run ids (#2603, #3145)`,
    );
    if (next === source) {
      fail(`OpenClaw chat.send run-start shape not recognized in ${file}`);
    }
    source = next;
  }

  if (!source.includes("idempotencyKey: clientRunId")) {
    let inserted = false;
    source = source.replace(
      /(createIfMissing: true,\n)(\s*)(ttsSupplement: ttsSupplementMarker,)/g,
      (match, prefix, indent, ttsLine, offset) => {
        const preceding = source.slice(Math.max(0, offset - 300), offset);
        if (preceding.includes("idempotencyKey:")) return match;
        inserted = true;
        return `${prefix}${indent}idempotencyKey: clientRunId,\n${indent}${ttsLine}`;
      },
    );
    if (!inserted) {
      fail(`OpenClaw chat.send transcript append shape not recognized in ${file}`);
    }
  }

  if (!source.includes("suppressing empty final event")) {
    const next = source.replace(
      /\n(\s*)broadcastChatFinal\(\{\n(\s*)context,\n\s*runId: clientRunId,\n\s*sessionKey,\n\s*message\n\s*\}\);/,
      (_match, outerIndent, innerIndent) =>
        `\n${outerIndent}if (message) broadcastChatFinal({\n` +
        `${innerIndent}context,\n` +
        `${innerIndent}runId: clientRunId,\n` +
        `${innerIndent}sessionKey,\n` +
        `${innerIndent}message\n` +
        `${outerIndent}}); else context.logGateway.warn("webchat chat.send completed without visible assistant reply; suppressing empty final event (nemoclaw #2603/#3145)");`,
    );
    if (next === source) {
      fail(`OpenClaw chat.send empty-final shape not recognized in ${file}`);
    }
    source = next;
  }

  if (source !== original) {
    fs.writeFileSync(file, source);
    return true;
  }
  return false;
}

function patchFollowupRunnerFile(file) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;

  if (
    source.includes(
      "const runId = opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue",
    )
  ) {
    source = source.replace(
      "const runId = opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue",
      "const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue",
    );
  }

  if (!source.includes("preserve chat.send run ids in followup queue")) {
    const hasOptsBinding =
      /\bfunction\s+runQueuedFollowup\(\s*queued,\s*opts\b/.test(source) ||
      /\bconst\s+\{[^}]*\bopts\b[^}]*\}\s*=\s*params;/.test(source);
    if (!hasOptsBinding) {
      fail(`OpenClaw followup runner opts binding not recognized in ${file}`);
    }

    // Source boundary: OpenClaw 2026.5.18 passed opts into runQueuedFollowup,
    // 2026.5.22 closes over params.opts and uses createReplyOperation, and
    // 2026.5.27 closes over params.opts and admits a queued reply turn before
    // creating the run id. All reviewed shapes must have opts and queued in
    // scope before this NemoClaw run-id preservation shim is inserted.
    let next = source.replace(
      /(replyOperation = createReplyOperation\(\{\n\s*sessionId: run\.sessionId,\n\s*sessionKey: replySessionKey \?\? "",\n\s*resetTriggered: false,\n\s*upstreamAbortSignal: queued\.abortSignal(?: \?\? opts\?\.abortSignal)?\n\s*\}\);\n\s*)const runId = crypto\.randomUUID\(\);/,
      (_match, prefix) =>
        `${prefix}const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); ` +
        `// nemoclaw: preserve chat.send run ids in followup queue (#2603, #3145)`,
    );
    if (next === source) {
      next = source.replace(
        /(const admission = await admitReplyTurn\(\{\n\s*sessionId: run\.sessionId,\n\s*sessionKey: replySessionKey \?\? "",\n\s*kind: "queued_followup",\n\s*resetTriggered: false,\n\s*upstreamAbortSignal: queued\.abortSignal\n\s*\}\);[\s\S]*?replyOperation = admission\.operation;[\s\S]*?\n\s*)const runId = crypto\.randomUUID\(\);/,
        (_match, prefix) =>
          `${prefix}const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); ` +
          `// nemoclaw: preserve chat.send run ids in followup queue (#2603, #3145)`,
      );
    }
    if (next === source) {
      fail(`OpenClaw followup runner run-id shape not recognized in ${file}`);
    }
    source = next;
  }

  if (source !== original) {
    fs.writeFileSync(file, source);
    return true;
  }
  return false;
}

function patchGetReplyFile(file) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;

  if (!source.includes("carry chat.send run id into queued followup")) {
    const next = source.replace(
      /(const followupRun = \{\n)(\s*)prompt: queuedBody,/,
      (_match, prefix, indent) =>
        `${prefix}${indent}runId: opts?.runId, ` +
        `// nemoclaw: carry chat.send run id into queued followup (#2603, #3145)\n` +
        `${indent}prompt: queuedBody,`,
    );
    if (next === source) {
      fail(`OpenClaw get-reply followup run shape not recognized in ${file}`);
    }
    source = next;
  }

  if (!source.includes("force webchat chat.send queued turns")) {
    if (source.includes("const resolvedQueue = useFastReplyRuntime ? {")) {
      source = source.replace(
        "const resolvedQueue = useFastReplyRuntime ? {",
        "let resolvedQueue = useFastReplyRuntime ? {",
      );
    } else if (!source.includes("let resolvedQueue = useFastReplyRuntime ? {")) {
      fail(`OpenClaw get-reply queue settings shape not recognized in ${file}`);
    }

    const next = source.replace(
      /\n(\s*)const piRuntime = useFastReplyRuntime \? null : await traceRunPhase\("reply\.load_pi_runtime", \(\) => loadPiEmbeddedRuntime\(\)\);/,
      (_match, indent) =>
        `\n${indent}if (opts?.runId && sessionCtx.Provider === "webchat" && resolvedQueue.mode === "steer") resolvedQueue = {\n` +
        `${indent}\t...resolvedQueue,\n` +
        `${indent}\tmode: "followup",\n` +
        `${indent}\tdebounceMs: 0\n` +
        `${indent}}; // nemoclaw: force webchat chat.send queued turns to keep per-message replies (#2603, #3145)\n` +
        `${indent}const piRuntime = useFastReplyRuntime ? null : await traceRunPhase("reply.load_pi_runtime", () => loadPiEmbeddedRuntime());`,
    );
    if (next === source) {
      fail(`OpenClaw get-reply pi runtime shape not recognized in ${file}`);
    }
    source = next;
  }

  if (source !== original) {
    fs.writeFileSync(file, source);
    return true;
  }
  return false;
}

const candidates = listJsFiles(distDir).filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return source.includes('"chat.send"') && source.includes("onAgentRunStart");
});

if (candidates.length !== 1) {
  fail(`expected exactly one OpenClaw chat.send runtime file, found ${candidates.length}`);
}

const chatFile = candidates[0];
patchChatSendFile(chatFile);

const getReplyCandidates = listJsFiles(distDir).filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return (
    source.includes("resolveQueueSettings") &&
    (source.includes("const followupRun = {") ||
      source.includes("carry chat.send run id into queued followup"))
  );
});

if (getReplyCandidates.length !== 1) {
  fail(`expected exactly one OpenClaw get-reply runtime file, found ${getReplyCandidates.length}`);
}

const getReplyFile = getReplyCandidates[0];
patchGetReplyFile(getReplyFile);

const followupCandidates = listJsFiles(distDir).filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return (
    source.includes("function createFollowupRunner") &&
    (source.includes("replyOperation = createReplyOperation") ||
      (source.includes("admitReplyTurn") &&
        source.includes("replyOperation = admission.operation")) ||
      source.includes("preserve chat.send run ids in followup queue")) &&
    (source.includes("const runId = crypto.randomUUID();") ||
      source.includes("preserve chat.send run ids in followup queue"))
  );
});

if (followupCandidates.length !== 1) {
  fail(
    `expected exactly one OpenClaw followup runner runtime file, found ${followupCandidates.length}`,
  );
}

const followupFile = followupCandidates[0];
patchFollowupRunnerFile(followupFile);

const patched = fs.readFileSync(chatFile, "utf8");
if (!patched.includes("nemoclaw: correlate chat.send run ids")) {
  fail("chat.send run-id correlation patch did not apply");
}
if (!patched.includes("idempotencyKey: clientRunId")) {
  fail("chat.send transcript idempotency patch did not apply");
}
if (!patched.includes("suppressing empty final event")) {
  fail("chat.send empty-final suppression patch did not apply");
}

const patchedGetReply = fs.readFileSync(getReplyFile, "utf8");
if (!patchedGetReply.includes("carry chat.send run id into queued followup")) {
  fail("get-reply queued run-id patch did not apply");
}
if (!patchedGetReply.includes("force webchat chat.send queued turns")) {
  fail("get-reply webchat queue mode patch did not apply");
}

const patchedFollowup = fs.readFileSync(followupFile, "utf8");
if (!patchedFollowup.includes("preserve chat.send run ids in followup queue")) {
  fail("followup runner run-id patch did not apply");
}

console.log(
  `INFO: patched OpenClaw chat.send compatibility in ${path.basename(chatFile)}, ${path.basename(getReplyFile)}, and ${path.basename(followupFile)}`,
);
