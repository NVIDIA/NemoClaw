// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedImageOpenShellE2eProbeContext,
  ManagedImageOpenShellE2eProbeResult,
} from "./run-managed-image-openshell-e2e.ts";

export type LlamaCppOpenClawAgentQualificationPlan = {
  readonly agent: "openclaw";
  readonly bounds: {
    readonly commandTimeoutSeconds: number;
    readonly maxResponseBytes: number;
    readonly maxStreamEvents: number;
    readonly maxTokens: number;
  };
  readonly execution: "disabled" | "enabled";
  readonly fixture: {
    readonly path: string;
    readonly value: string;
  };
  readonly expectations: {
    readonly normal: string;
  };
  readonly image: {
    readonly reference: string;
    readonly sourceRevision: string;
  };
  readonly probes: readonly string[];
  readonly prompts: {
    readonly continuation: string;
    readonly normal: string;
    readonly tool: string;
  };
  readonly route: {
    readonly api: "openai-completions";
    readonly provider: "llama-cpp-local";
    readonly routedBaseUrl: "https://inference.local/v1";
    readonly upstreamBaseUrl: "http://host.openshell.internal:8081/v1";
  };
  readonly runtimeProvider: "docker";
  readonly sandbox: {
    readonly gpuAccess: "disabled";
    readonly name: string;
  };
  readonly sessions: {
    readonly normal: string;
    readonly tool: string;
  };
  readonly tool: {
    readonly name: "read";
  };
};

export type LlamaCppOpenClawAgentQualificationEvidence = {
  readonly agentMultiTurn: true;
  readonly agentNormalTurn: true;
  readonly agentToolCall: {
    readonly argumentsValid: true;
    readonly name: LlamaCppOpenClawAgentQualificationPlan["tool"]["name"];
  };
  readonly agentToolResultContinuation: true;
  readonly streamingChat: {
    readonly done: true;
    readonly events: number;
  };
  readonly synchronousChat: true;
};

function requireSuccess(
  result: ManagedImageOpenShellE2eProbeResult,
  label: string,
  maximumBytes: number,
): void {
  const bytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  if (bytes > maximumBytes) throw new Error(`${label} exceeded the declarative response bound`);
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status ?? "unknown"}`);
  }
}

function agentArgv(session: string, prompt: string, timeoutSeconds: number): string[] {
  return [
    "openclaw",
    "agent",
    "--agent",
    "main",
    "--json",
    "--thinking",
    "off",
    "--timeout",
    String(timeoutSeconds),
    "--session-id",
    session,
    "-m",
    prompt,
  ];
}

const INFERENCE_PROBE_SOURCE = String.raw`
const [completionUrl, mode, model, prompt, expected, maxTokensText, maxEventsText, maxBytesText] = process.argv.slice(1);
const streaming = mode === "stream";
const response = await fetch(completionUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: Number.parseInt(maxTokensText, 10),
    stream: streaming,
  }),
});
if (!response.ok) throw new Error("inference.local returned HTTP " + response.status);
const maximumBytes = Number.parseInt(maxBytesText, 10);
const chunks = [];
let responseBytes = 0;
for await (const chunk of response.body) {
  responseBytes += chunk.byteLength;
  if (responseBytes > maximumBytes) throw new Error("inference.local response exceeded its bound");
  chunks.push(Buffer.from(chunk));
}
const source = Buffer.concat(chunks).toString("utf8");
if (!streaming) {
  const body = JSON.parse(source);
  const text = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? "";
  if (!String(text).toLocaleUpperCase("en-US").includes(expected.toLocaleUpperCase("en-US"))) throw new Error("synchronous response mismatch");
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  const events = source.split(/\r?\n/).filter((line) => line.startsWith("data: "));
  const maximum = Number.parseInt(maxEventsText, 10);
  if (events.length < 2 || events.length > maximum || !events.some((line) => line === "data: [DONE]")) {
    throw new Error("streaming response framing mismatch");
  }
  const text = events
    .filter((line) => line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content ?? "")
    .join("");
  if (!text.toLocaleUpperCase("en-US").includes(expected.toLocaleUpperCase("en-US"))) throw new Error("streaming response mismatch");
  process.stdout.write(JSON.stringify({ done: true, events: events.length }));
}
`;

export const LLAMA_CPP_OPENCLAW_SESSION_PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const [sessionPath, trajectoryPath, toolName, fixturePath, fixtureValue] = process.argv.slice(1);
const items = fs.readFileSync(sessionPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const sessionMessages = items.filter((item) => item?.type === "message" && item?.message).map((item) => item.message);
const trajectoryItems = fs.existsSync(trajectoryPath)
  ? fs.readFileSync(trajectoryPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
let projectedMessages = [];
for (const item of trajectoryItems) {
  if (item?.type === "model.completed" && Array.isArray(item?.data?.messagesSnapshot)) {
    projectedMessages = item.data.messagesSnapshot.map((value) => value?.message ?? value);
  }
}
const messages = [...sessionMessages, ...projectedMessages];
const blocks = messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
const calls = blocks.filter((block) => block?.type === "toolCall");
const exactCalls = calls.filter((call) =>
  (call.name === toolName || call.toolName === toolName) &&
  (call.arguments ?? call.input ?? call.args)?.path === fixturePath
);
const results = messages.filter((message) => message?.role === "toolResult");
const exactCallIds = new Set(exactCalls.map((call) => call.id ?? call.toolCallId ?? call.tool_call_id).filter(Boolean));
const matchingResults = results.filter((message) =>
  exactCallIds.has(message.toolCallId ?? message.tool_call_id ?? message.id) &&
  JSON.stringify(message).includes(fixtureValue)
);
const users = sessionMessages.filter((message) => message?.role === "user");
const finalAssistant = sessionMessages.at(-1)?.role === "assistant";
if (exactCalls.length < 1 || matchingResults.length < 1 || users.length < 2 || !finalAssistant) {
  process.stderr.write(JSON.stringify({
    callNames: calls.map((call) => call.name ?? call.toolName ?? null),
    exactCalls: exactCalls.length,
    matchingResults: matchingResults.length,
    resultNames: results.map((message) => message.toolName ?? message.tool_name ?? message.name ?? null),
    users: users.length,
    finalAssistant,
  }));
  throw new Error("OpenClaw session did not prove the declared tool-call continuation flow");
}
process.stdout.write(JSON.stringify({ calls: exactCalls.length, results: matchingResults.length, users: users.length }));
`;

function parseJson(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} did not return bounded JSON evidence`);
  }
}

export async function runLlamaCppOpenClawAgentQualification(
  config: LlamaCppOpenClawAgentQualificationPlan,
  context: ManagedImageOpenShellE2eProbeContext,
): Promise<LlamaCppOpenClawAgentQualificationEvidence> {
  if (
    config.execution !== "enabled" ||
    context.input.agent !== config.agent ||
    context.input.localProvider !== "llama-cpp" ||
    context.input.model === undefined ||
    context.input.sandbox !== config.sandbox.name ||
    context.input.gpu === true
  ) {
    throw new Error("OpenClaw agent qualification invocation does not match its declarative plan");
  }
  const timeout = config.bounds.commandTimeoutSeconds * 1_000;
  const run = (argv: readonly string[], label: string) => {
    const result = context.runSandbox(argv, timeout);
    requireSuccess(result, label, config.bounds.maxResponseBytes);
    return result;
  };

  const synchronous = run(
    [
      "node",
      "--input-type=module",
      "-e",
      INFERENCE_PROBE_SOURCE,
      `${config.route.routedBaseUrl}/chat/completions`,
      "sync",
      context.input.model,
      config.prompts.normal,
      config.expectations.normal,
      String(config.bounds.maxTokens),
      String(config.bounds.maxStreamEvents),
      String(config.bounds.maxResponseBytes),
    ],
    "inference.local synchronous probe",
  );
  const synchronousEvidence = parseJson(synchronous.stdout, "synchronous probe");
  if (synchronousEvidence.ok !== true) throw new Error("synchronous probe evidence is invalid");

  const streaming = run(
    [
      "node",
      "--input-type=module",
      "-e",
      INFERENCE_PROBE_SOURCE,
      `${config.route.routedBaseUrl}/chat/completions`,
      "stream",
      context.input.model,
      config.prompts.normal,
      config.expectations.normal,
      String(config.bounds.maxTokens),
      String(config.bounds.maxStreamEvents),
      String(config.bounds.maxResponseBytes),
    ],
    "inference.local streaming probe",
  );
  const streamingEvidence = parseJson(streaming.stdout, "streaming probe");
  const events = Number(streamingEvidence.events);
  if (
    streamingEvidence.done !== true ||
    !Number.isSafeInteger(events) ||
    events < 2 ||
    events > config.bounds.maxStreamEvents
  ) {
    throw new Error("streaming probe evidence is invalid");
  }

  const normal = run(
    agentArgv(config.sessions.normal, config.prompts.normal, config.bounds.commandTimeoutSeconds),
    "OpenClaw normal agent turn",
  );
  if (
    !normal.stdout
      .toLocaleUpperCase("en-US")
      .includes(config.expectations.normal.toLocaleUpperCase("en-US"))
  ) {
    throw new Error("OpenClaw normal agent turn did not pass");
  }

  run(
    [
      "/bin/sh",
      "-eu",
      "-c",
      'umask 077; printf "%s" "$1" > "$2"',
      "fixture",
      config.fixture.value,
      config.fixture.path,
    ],
    "OpenClaw tool fixture creation",
  );
  const tool = run(
    agentArgv(config.sessions.tool, config.prompts.tool, config.bounds.commandTimeoutSeconds),
    "OpenClaw tool agent turn",
  );
  if (!tool.stdout.includes(config.fixture.value)) {
    throw new Error("OpenClaw tool agent turn did not return the declared fixture value");
  }
  const continuation = run(
    agentArgv(
      config.sessions.tool,
      config.prompts.continuation,
      config.bounds.commandTimeoutSeconds,
    ),
    "OpenClaw tool-result continuation turn",
  );
  if (!continuation.stdout.includes(config.fixture.value)) {
    throw new Error("OpenClaw tool-result continuation did not retain the prior result");
  }

  const session = run(
    [
      "node",
      "-e",
      LLAMA_CPP_OPENCLAW_SESSION_PROBE_SOURCE,
      `/sandbox/.openclaw/agents/main/sessions/${config.sessions.tool}.jsonl`,
      `/sandbox/.openclaw/agents/main/sessions/${config.sessions.tool}.trajectory.jsonl`,
      config.tool.name,
      config.fixture.path,
      config.fixture.value,
    ],
    "OpenClaw session structure probe",
  );
  const sessionEvidence = parseJson(session.stdout, "OpenClaw session structure probe");
  if (
    !Number.isSafeInteger(sessionEvidence.calls) ||
    Number(sessionEvidence.calls) < 1 ||
    !Number.isSafeInteger(sessionEvidence.results) ||
    Number(sessionEvidence.results) < 1 ||
    !Number.isSafeInteger(sessionEvidence.users) ||
    Number(sessionEvidence.users) < 2
  ) {
    throw new Error("OpenClaw session structure evidence is invalid");
  }

  return {
    agentMultiTurn: true,
    agentNormalTurn: true,
    agentToolCall: { argumentsValid: true, name: config.tool.name },
    agentToolResultContinuation: true,
    streamingChat: { done: true, events },
    synchronousChat: true,
  };
}
