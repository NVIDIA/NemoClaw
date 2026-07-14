// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildRebuildInferenceProbeCommand,
  preflightRebuildInferenceRoute,
} from "./rebuild-inference-preflight";

const input = {
  sandboxName: "dcode-workspace",
  provider: "compatible-endpoint",
  model: "nvidia/nemotron",
  preferredInferenceApi: "openai-completions",
};

describe("atomic rebuild inference preflight", () => {
  it("probes the recorded model through inference.local without embedding a credential (#6195)", () => {
    const command = buildRebuildInferenceProbeCommand(input);

    expect(command).toContain("https://inference.local/v1/chat/completions");
    expect(command).toContain('"model":"nvidia/nemotron"');
    expect(command).not.toMatch(/api[_-]?key|authorization|bearer/i);
    expect(command).not.toMatch(/curl\s+[^;]*-[^-\s]*k/);
    expect(command).not.toContain("head -c");
  });

  it("fails closed and redacts diagnostics when the stored gateway credential is rejected (#6195)", () => {
    const execute = vi.fn(() => ({
      status: 1,
      stdout: "401",
      stderr: "upstream authentication failed for sk-secret-value-that-is-long-enough",
    }));

    const result = preflightRebuildInferenceRoute(input, { execute });

    expect(result).toEqual({
      ok: false,
      detail: "existing sandbox inference probe returned HTTP 401",
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret-value-that-is-long-enough");
  });

  it("never reports an arbitrary response body from the failed route (#6195)", () => {
    const execute = vi.fn(() => ({
      status: 1,
      stdout: '500\n{"echoed_value":"canary-replay-marker"}',
      stderr: "upstream echoed canary-replay-marker",
    }));

    const result = preflightRebuildInferenceRoute(input, { execute });

    expect(result).toEqual({
      ok: false,
      detail: "existing sandbox inference probe returned HTTP 500",
    });
    expect(JSON.stringify(result)).not.toContain("canary-replay-marker");
  });

  it("accepts a successful completion through the stored gateway route (#6195)", () => {
    const execute = vi.fn(() => ({ status: 0, stdout: "200\n{}", stderr: "" }));

    expect(preflightRebuildInferenceRoute(input, { execute })).toEqual({ ok: true });
  });

  it("sends max_completion_tokens for a GPT-5 model on the chat completions route", () => {
    const command = buildRebuildInferenceProbeCommand({ ...input, model: "gpt-5.4" });

    expect(command).toContain("https://inference.local/v1/chat/completions");
    expect(command).toContain('"max_completion_tokens":8');
    expect(command).not.toContain('"max_tokens"');
  });

  it("sends max_completion_tokens for an o-series model on the chat completions route", () => {
    const command = buildRebuildInferenceProbeCommand({ ...input, model: "o3-mini" });

    expect(command).toContain('"max_completion_tokens":8');
    expect(command).not.toContain('"max_tokens"');
  });

  it("keeps max_tokens for a model that supports the legacy chat completions field", () => {
    const command = buildRebuildInferenceProbeCommand({ ...input, model: "nvidia/nemotron" });

    expect(command).toContain('"max_tokens":8');
    expect(command).not.toContain('"max_completion_tokens"');
  });
});
