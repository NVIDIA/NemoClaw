// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { OLLAMA_PORT } from "../../../dist/lib/core/ports";
import { MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW } from "../../../dist/lib/inference/ollama-runtime-context";
import { mergeOllamaLoopbackSystemdOverride } from "../../../dist/lib/onboard/ollama-systemd";

describe("mergeOllamaLoopbackSystemdOverride", () => {
  it("writes the OLLAMA_HOST and OLLAMA_CONTEXT_LENGTH lines under [Service] when no drop-in exists", () => {
    const out = mergeOllamaLoopbackSystemdOverride("");
    expect(out).toContain("[Service]");
    expect(out).toContain(`Environment="OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}"`);
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
  });

  it("preserves an existing user-supplied OLLAMA_CONTEXT_LENGTH that is above the NemoClaw floor", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_HOST=0.0.0.0:11434"',
      'Environment="OLLAMA_CONTEXT_LENGTH=65536"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain(`Environment="OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}"`);
    expect(out).toContain('Environment="OLLAMA_CONTEXT_LENGTH=65536"');
    expect(out).not.toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
    // Legacy 0.0.0.0 line must be stripped.
    expect(out).not.toContain('Environment="OLLAMA_HOST=0.0.0.0:11434"');
  });

  it("replaces a stale OLLAMA_CONTEXT_LENGTH below the NemoClaw floor", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_HOST=127.0.0.1:11434"',
      'Environment="OLLAMA_CONTEXT_LENGTH=4096"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
    expect(out).not.toContain('Environment="OLLAMA_CONTEXT_LENGTH=4096"');
  });

  it("preserves unrelated variables sharing an Environment line with managed Ollama settings", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_CONTEXT_LENGTH=4096" "OLLAMA_ORIGINS=http://127.0.0.1" "HTTPS_PROXY=http://proxy.local"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain(
      'Environment="OLLAMA_ORIGINS=http://127.0.0.1" "HTTPS_PROXY=http://proxy.local"',
    );
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
    expect(out).not.toContain('Environment="OLLAMA_CONTEXT_LENGTH=4096"');
  });

  it("keeps commented-out OLLAMA_CONTEXT_LENGTH lines verbatim", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_HOST=127.0.0.1:11434"',
      '# Environment="OLLAMA_CONTEXT_LENGTH=8192"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain('# Environment="OLLAMA_CONTEXT_LENGTH=8192"');
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
  });

  it("threads through the libraryOverride option alongside the context length", () => {
    const out = mergeOllamaLoopbackSystemdOverride("", { libraryOverride: "cuda_v13" });
    expect(out).toContain('Environment="OLLAMA_LLM_LIBRARY=cuda_v13"');
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
  });
});
