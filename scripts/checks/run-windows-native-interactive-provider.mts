// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

const port = Number(argument("--port"));
const inputMarker = argument("--input-marker");
const outputMarker = argument("--output-marker");
const artifactRoot = path.resolve(argument("--artifact-directory"));
const turnCount = process.argv.includes("--turns") ? Number(argument("--turns")) : 1;
if (turnCount !== 1 && turnCount !== 3) throw new Error("Invalid interactive turn count");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid provider port");
if (
  !/^NEMOCLAW_INTERACTIVE_INPUT_[a-f0-9]{16}$/u.test(inputMarker) ||
  !/^NEMOCLAW_INTERACTIVE_OUTPUT_[a-f0-9]{16}$/u.test(outputMarker)
) {
  throw new Error("Invalid interactive proof marker");
}
if (!fs.statSync(artifactRoot).isDirectory())
  throw new Error("Provider evidence directory is missing");
const receiptPath = path.join(artifactRoot, "provider.json");
if (fs.existsSync(receiptPath)) throw new Error("Provider evidence already exists");
const receipt = {
  schemaVersion: 1,
  classification: "native-interactive-hermes-provider",
  model: "native-preview-qualification",
  inputMarker,
  outputMarker,
  requests: 0,
  inputObserved: false,
  responseSent: false,
  streamingResponse: false,
  turns: Array.from({ length: turnCount }, (_, index) => ({
    index: index + 1,
    inputMarker: turnCount === 1 ? inputMarker : `${inputMarker}_${index + 1}`,
    outputMarker: turnCount === 1 ? outputMarker : `${outputMarker}_${index + 1}`,
    inputObserved: false,
    responseSent: false,
  })),
};
function saveReceipt(): void {
  const temporary = `${receiptPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, receiptPath);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: receipt.model, object: "model", owned_by: "native-qualification" }],
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error("Provider request exceeded its bound");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.model !== receipt.model || !Array.isArray(body.messages)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Unexpected qualification model or messages" } }),
      );
      return;
    }
    const lastUser = body.messages
      .filter((message: { role?: unknown }) => message.role === "user")
      .at(-1);
    const lastText =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content
              .filter(
                (part: { type?: unknown; text?: unknown }) =>
                  part.type === "text" && typeof part.text === "string",
              )
              .map((part: { text: string }) => part.text)
              .join("\n")
          : "";
    const turn = receipt.turns.find((item) => lastText.includes(item.inputMarker));
    const observed = turn !== undefined;
    receipt.requests++;
    receipt.inputObserved ||= observed;
    if (turn) turn.inputObserved = true;
    const content = turn?.outputMarker ?? "Ready for the interactive qualification message.";
    const common = {
      id: "chatcmpl-native-interactive",
      created: Math.floor(Date.now() / 1000),
      model: receipt.model,
    };
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const delta of [{ role: "assistant", content: "" }, { content }]) {
        response.write(
          `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      receipt.streamingResponse = true;
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
    receipt.responseSent ||= observed;
    if (turn) turn.responseSent = true;
    saveReceipt();
  } catch {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: "Interactive qualification provider failed" } }),
    );
  }
});
server.listen(port, "127.0.0.1", () => {
  saveReceipt();
  console.log("Native interactive qualification provider ready.");
});
const deadline = setTimeout(
  () => {
    server.closeAllConnections();
    server.close(() => process.exit(1));
  },
  (turnCount === 3 ? 45 : 30) * 60_000,
);
process.once("SIGTERM", () => {
  clearTimeout(deadline);
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
