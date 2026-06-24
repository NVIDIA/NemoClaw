#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary NemoClaw compatibility shim for OpenClaw 2026.5.x and 2026.6.x
 * chat.send gateway behavior. Remove this when upstream OpenClaw preserves
 * submitted chat.send run lineage and stops emitting empty terminal chat
 * events.
 */

const fs = require("node:fs");
const path = require("node:path");

const AUDIT_FLAG = "--audit";
const EXIT_APPLY_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_AUDIT_FAILURE = 3;

const args = process.argv.slice(2);
const auditMode = args.includes(AUDIT_FLAG);
const positional = args.filter((value) => value !== AUDIT_FLAG);
const distDir = positional[0];

if (!distDir || positional.length > 1) {
  console.error("Usage: patch-openclaw-chat-send.js [--audit] <openclaw-dist-dir>");
  process.exit(EXIT_USAGE);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_APPLY_FAILURE);
}

function listJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(dir, entry.name));
}

function patchChatSendRunStart(source, file) {
  if (source.includes("nemoclaw: correlate chat.send run ids")) {
    return { nextSource: source, status: "already-applied" };
  }
  const nextSource = source.replace(
    /(onAgentRunStart: \(runId\) => \{\n)(\s*)agentRunStarted = true;/,
    (_match, prefix, indent) =>
      `${prefix}${indent}agentRunStarted = true;\n` +
      `${indent}if (runId && runId !== clientRunId) context.addChatRun(runId, { sessionKey, clientRunId }); ` +
      `// nemoclaw: correlate chat.send run ids (#2603, #3145)`,
  );
  if (nextSource === source) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw chat.send run-start shape not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

function patchChatSendTranscriptIdempotency(source, file) {
  if (source.includes("idempotencyKey: clientRunId")) {
    return { nextSource: source, status: "already-applied" };
  }
  let inserted = false;
  const nextSource = source.replace(
    /(createIfMissing: true,\n)(\s*)(ttsSupplement: ttsSupplementMarker,)/g,
    (match, prefix, indent, ttsLine, offset) => {
      const preceding = source.slice(Math.max(0, offset - 300), offset);
      if (preceding.includes("idempotencyKey:")) return match;
      inserted = true;
      return `${prefix}${indent}idempotencyKey: clientRunId,\n${indent}${ttsLine}`;
    },
  );
  if (!inserted) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw chat.send transcript append shape not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

function patchChatSendEmptyFinal(source, file) {
  if (source.includes("suppressing empty final event")) {
    return { nextSource: source, status: "already-applied" };
  }
  const nextSource = source.replace(
    /\n(\s*)broadcastChatFinal\(\{\n(\s*)context,\n\s*runId: clientRunId,\n\s*sessionKey,\n(\s*agentId,\n)?\s*message\n\s*\}\);/,
    (_match, outerIndent, innerIndent, agentIdLine) =>
      `\n${outerIndent}if (message) broadcastChatFinal({\n` +
      `${innerIndent}context,\n` +
      `${innerIndent}runId: clientRunId,\n` +
      `${innerIndent}sessionKey,\n` +
      (agentIdLine || "") +
      `${innerIndent}message\n` +
      `${outerIndent}}); else context.logGateway.warn("webchat chat.send completed without visible assistant reply; suppressing empty final event (nemoclaw #2603/#3145)");`,
  );
  if (nextSource === source) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw chat.send empty-final shape not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

function patchGetReplyFollowupRunId(source, file) {
  if (source.includes("carry chat.send run id into queued followup")) {
    return { nextSource: source, status: "already-applied" };
  }
  const nextSource = source.replace(
    /(const followupRun = \{\n)(\s*)prompt: queuedBody,/,
    (_match, prefix, indent) =>
      `${prefix}${indent}runId: opts?.runId, ` +
      `// nemoclaw: carry chat.send run id into queued followup (#2603, #3145)\n` +
      `${indent}prompt: queuedBody,`,
  );
  if (nextSource === source) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw get-reply followup run shape not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

function patchGetReplyWebchatQueueMode(source, file) {
  if (source.includes("force webchat chat.send queued turns")) {
    return { nextSource: source, status: "already-applied" };
  }
  let working = source;
  if (working.includes("const resolvedQueue = useFastReplyRuntime ? {")) {
    working = working.replace(
      "const resolvedQueue = useFastReplyRuntime ? {",
      "let resolvedQueue = useFastReplyRuntime ? {",
    );
  } else if (!working.includes("let resolvedQueue = useFastReplyRuntime ? {")) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw get-reply queue settings shape not recognized in ${file}`,
    };
  }
  const nextSource = working.replace(
    /\n(\s*)(const (?:piRuntime|embeddedAgentRuntime) = useFastReplyRuntime \? null : await traceRunPhase\("reply\.(?:load_pi_runtime|load_embedded_agent_runtime)", \(\) => (?:loadPiEmbeddedRuntime|loadEmbeddedAgentRuntime)\(\)\);)/,
    (_match, indent, runtimeLine) =>
      `\n${indent}if (opts?.runId && sessionCtx.Provider === "webchat" && resolvedQueue.mode === "steer") resolvedQueue = {\n` +
      `${indent}\t...resolvedQueue,\n` +
      `${indent}\tmode: "followup",\n` +
      `${indent}\tdebounceMs: 0\n` +
      `${indent}}; // nemoclaw: force webchat chat.send queued turns to keep per-message replies (#2603, #3145)\n` +
      `${indent}${runtimeLine}`,
  );
  if (nextSource === working) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw get-reply embedded-agent runtime shape not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

function patchFollowupRunIdPreservation(source, file) {
  let working = source;
  const legacyShim =
    "const runId = opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue";
  if (working.includes(legacyShim)) {
    working = working.replace(
      legacyShim,
      "const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); // nemoclaw: preserve chat.send run ids in followup queue",
    );
  }
  if (working.includes("preserve chat.send run ids in followup queue")) {
    return {
      nextSource: working,
      status: working === source ? "already-applied" : "would-apply",
    };
  }
  const hasOptsBinding =
    /\bfunction\s+runQueuedFollowup\(\s*queued,\s*opts\b/.test(working) ||
    /\bconst\s+\{[^}]*\bopts\b[^}]*\}\s*=\s*params;/.test(working);
  if (!hasOptsBinding) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw followup runner opts binding not recognized in ${file}`,
    };
  }
  let nextSource = working.replace(
    /(replyOperation = createReplyOperation\(\{\n\s*sessionId: run\.sessionId,\n\s*sessionKey: replySessionKey \?\? "",\n\s*resetTriggered: false,\n\s*upstreamAbortSignal: queued\.abortSignal(?: \?\? opts\?\.abortSignal)?\n\s*\}\);\n\s*)const runId = crypto\.randomUUID\(\);/,
    (_match, prefix) =>
      `${prefix}const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); ` +
      `// nemoclaw: preserve chat.send run ids in followup queue (#2603, #3145)`,
  );
  if (nextSource === working) {
    nextSource = working.replace(
      /(const admission = await admitReplyTurn\(\{\n\s*sessionId: run\.sessionId,\n\s*sessionKey: replySessionKey \?\? "",\n\s*kind: "queued_followup",\n\s*resetTriggered: false,\n\s*(?:routeThreadId: queued\.originatingThreadId,\n\s*)?upstreamAbortSignal: queued\.abortSignal\n\s*\}\);[\s\S]*?replyOperation = admission\.operation;[\s\S]*?\n\s*)const runId = crypto\.randomUUID\(\);/,
      (_match, prefix) =>
        `${prefix}const runId = queued.runId ?? opts?.runId ?? crypto.randomUUID(); ` +
        `// nemoclaw: preserve chat.send run ids in followup queue (#2603, #3145)`,
    );
  }
  if (nextSource === working) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw followup runner run-id shape not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

const FILES = [
  {
    id: "chat-send",
    label: "chat.send runtime",
    selector(source) {
      return source.includes('"chat.send"') && source.includes("onAgentRunStart");
    },
    recognizers: [
      {
        id: "run-start",
        marker: "nemoclaw: correlate chat.send run ids",
        postVerifyError: "chat.send run-id correlation patch did not apply",
        patch: patchChatSendRunStart,
      },
      {
        id: "transcript-idempotency",
        marker: "idempotencyKey: clientRunId",
        postVerifyError: "chat.send transcript idempotency patch did not apply",
        patch: patchChatSendTranscriptIdempotency,
      },
      {
        id: "empty-final",
        marker: "suppressing empty final event",
        postVerifyError: "chat.send empty-final suppression patch did not apply",
        patch: patchChatSendEmptyFinal,
      },
    ],
  },
  {
    id: "get-reply",
    label: "get-reply runtime",
    selector(source) {
      return (
        source.includes("resolveQueueSettings") &&
        (source.includes("const followupRun = {") ||
          source.includes("carry chat.send run id into queued followup"))
      );
    },
    recognizers: [
      {
        id: "followup-run-id",
        marker: "carry chat.send run id into queued followup",
        postVerifyError: "get-reply queued run-id patch did not apply",
        patch: patchGetReplyFollowupRunId,
      },
      {
        id: "webchat-queue-mode",
        marker: "force webchat chat.send queued turns",
        postVerifyError: "get-reply webchat queue mode patch did not apply",
        patch: patchGetReplyWebchatQueueMode,
      },
    ],
  },
  {
    id: "followup-runner",
    label: "followup runner runtime",
    selector(source) {
      return (
        source.includes("function createFollowupRunner") &&
        (source.includes("replyOperation = createReplyOperation") ||
          (source.includes("admitReplyTurn") &&
            source.includes("replyOperation = admission.operation")) ||
          source.includes("preserve chat.send run ids in followup queue")) &&
        (source.includes("const runId = crypto.randomUUID();") ||
          source.includes("preserve chat.send run ids in followup queue"))
      );
    },
    recognizers: [
      {
        id: "run-id-preservation",
        marker: "preserve chat.send run ids in followup queue",
        postVerifyError: "followup runner run-id patch did not apply",
        patch: patchFollowupRunIdPreservation,
      },
    ],
  },
];

function resolveFile(fileSpec, { dryRun }) {
  const candidates = listJsFiles(distDir).filter((file) =>
    fileSpec.selector(fs.readFileSync(file, "utf8")),
  );
  if (candidates.length !== 1) {
    const error = `expected exactly one OpenClaw ${fileSpec.label} file, found ${candidates.length}`;
    if (!dryRun) fail(error);
    return { file: null, error };
  }
  return { file: candidates[0] };
}

function processFile(fileSpec, file, { dryRun }) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;
  const recognizerResults = [];

  for (const recognizer of fileSpec.recognizers) {
    const result = recognizer.patch(source, file);
    recognizerResults.push({ id: recognizer.id, status: result.status, error: result.error });
    if (result.status === "no-match") {
      if (!dryRun) fail(result.error);
      continue;
    }
    if (result.status === "would-apply") {
      source = result.nextSource;
    }
  }

  if (!dryRun && source !== original) {
    fs.writeFileSync(file, source);
  }

  if (!dryRun) {
    const written = fs.readFileSync(file, "utf8");
    for (const recognizer of fileSpec.recognizers) {
      if (!written.includes(recognizer.marker)) {
        fail(recognizer.postVerifyError);
      }
    }
  }

  return recognizerResults;
}

function runApplyMode() {
  const summary = [];
  for (const fileSpec of FILES) {
    const { file } = resolveFile(fileSpec, { dryRun: false });
    processFile(fileSpec, file, { dryRun: false });
    summary.push(path.basename(file));
  }
  const [chat, getReply, followup] = summary;
  console.log(
    `INFO: patched OpenClaw chat.send compatibility in ${chat}, ${getReply}, and ${followup}`,
  );
}

function statusBadge(status) {
  switch (status) {
    case "applied":
    case "already-applied":
    case "would-apply":
      return "[OK]  ";
    case "no-match":
    case "selector-failed":
      return "[MISS]";
    default:
      return "[?]   ";
  }
}

function runAuditMode() {
  console.log(`patch-openclaw-chat-send audit: ${distDir}`);
  let totalRecognizers = 0;
  let okRecognizers = 0;
  let missingRecognizers = 0;
  let selectorFailures = 0;

  for (const fileSpec of FILES) {
    const { file, error: selectorError } = resolveFile(fileSpec, { dryRun: true });
    if (!file) {
      selectorFailures += 1;
      console.log("");
      console.log(`${fileSpec.label}: NOT FOUND`);
      console.log(`  ${statusBadge("selector-failed")} ${selectorError}`);
      for (const recognizer of fileSpec.recognizers) {
        totalRecognizers += 1;
        missingRecognizers += 1;
        console.log(`  ${statusBadge("no-match")} ${recognizer.id}: file unresolved`);
      }
      continue;
    }
    const results = processFile(fileSpec, file, { dryRun: true });
    console.log("");
    console.log(`${fileSpec.label}: ${path.basename(file)}`);
    for (const result of results) {
      totalRecognizers += 1;
      const badge = statusBadge(result.status);
      if (result.status === "no-match") {
        missingRecognizers += 1;
        console.log(`  ${badge} ${result.id}: ${result.error}`);
      } else {
        okRecognizers += 1;
        console.log(`  ${badge} ${result.id}: ${result.status}`);
      }
    }
  }

  console.log("");
  console.log(
    `Summary: ${totalRecognizers} recognizers · ${okRecognizers} OK · ${missingRecognizers} missing` +
      (selectorFailures > 0 ? ` · ${selectorFailures} file(s) NOT FOUND` : ""),
  );

  if (missingRecognizers > 0 || selectorFailures > 0) {
    process.exit(EXIT_AUDIT_FAILURE);
  }
}

if (auditMode) {
  runAuditMode();
} else {
  runApplyMode();
}
