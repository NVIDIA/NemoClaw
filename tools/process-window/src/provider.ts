// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Config } from "./model.js";

// Keep wire-protocol details separate from repository discovery.
export class ProviderSession {
  constructor(
    private settings: Config["inference"],
    private history: any[],
    private tools: any[],
    private key?: string,
  ) {}
  async next(): Promise<any> {
    const s = this.settings;
    const responses = s.api === "responses";
    const body = responses
      ? {
          model: s.model,
          input: this.history,
          tools: this.tools.map((t) => ({ type: "function", ...t.function, strict: false })),
          store: false,
          stream: true,
          include: ["reasoning.encrypted_content"],
          max_output_tokens: s.maxOutputTokens,
          ...(s.reasoningEffort ? { reasoning: { effort: s.reasoningEffort } } : {}),
        }
      : {
          model: s.model,
          messages: this.history,
          tools: this.tools,
          max_tokens: s.maxOutputTokens,
          ...(s.reasoningEffort ? { reasoning_effort: s.reasoningEffort } : {}),
        };
    const response = await fetch(
      `${s.baseUrl.replace(/\/$/, "")}/${responses ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(s.timeoutSeconds * 1000),
      },
    );
    if (!response.ok)
      throw Error(`Inference request failed (HTTP ${response.status}); response body suppressed`);
    let data: any;
    if (response.headers.get("content-type")?.includes("text/event-stream"))
      data = await readResponseStream(response);
    else {
      try {
        data = await response.json();
      } catch {
        throw Error("Provider returned invalid JSON; response body suppressed");
      }
    }
    if (responses) {
      if (data.status !== "completed" || !Array.isArray(data.output))
        throw Error("Inference response incomplete or failed; mapping unchanged");
      // Replay reasoning and function-call items unchanged for stateless reasoning continuity.
      this.history.push(...data.output);
      return {
        content: data.output
          .filter((i: any) => i.type === "message")
          .flatMap((i: any) => i.content ?? [])
          .filter((c: any) => c.type === "output_text")
          .map((c: any) => c.text)
          .join(""),
        tool_calls: data.output
          .filter((i: any) => i.type === "function_call")
          .map((i: any) => ({ id: i.call_id, function: { name: i.name, arguments: i.arguments } })),
      };
    }
    const choice = data.choices?.[0];
    if (!choice?.message || choice.finish_reason === "length")
      throw Error("Inference response missing or truncated; mapping unchanged");
    this.history.push(choice.message);
    return choice.message;
  }
  feedback(content: string): void {
    this.history.push({ role: "user", content });
  }
  result(id: string, value: unknown): void {
    const output = JSON.stringify(value);
    this.history.push(
      this.settings.api === "responses"
        ? { type: "function_call_output", call_id: id, output }
        : { role: "tool", tool_call_id: id, content: output },
    );
  }
}

// A completed event contains the full authoritative output; partial deltas are never published.
export async function readResponseStream(response: Response): Promise<any> {
  if (!response.body) throw Error("Provider stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed: any;
  const consume = (event: string) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let value: any;
    try {
      value = JSON.parse(data);
    } catch {
      throw Error("Invalid provider stream event; body suppressed");
    }
    if (["error", "response.failed", "response.incomplete"].includes(value.type))
      throw Error("Provider stream failed or is incomplete; mapping unchanged");
    if (value.type === "response.completed") completed = value.response;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        consume(pending.slice(0, boundary.index));
        if (completed) return completed;
        pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (done) break;
    }
    if (pending.trim()) consume(pending);
    if (!completed)
      throw Error("Provider stream ended without a completed response; mapping unchanged");
    return completed;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
