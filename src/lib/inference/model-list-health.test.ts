// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalProviderProbeOutputHealthy } from "./local";
import { isOpenAiModelListBody, waitForNimHealth } from "./nim";

const MODELS_ENDPOINT = "http://127.0.0.1:8000/v1/models";

describe("model list health checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["an HTML page", "<html>dev server</html>"],
    ["a JSON error", '{"error":"nope"}'],
    ["a top-level array", "[]"],
    ["JSON null", "null"],
    ["a non-array data field", '{"data":{}}'],
  ])("rejects %s as a vLLM models response", (_name, body) => {
    expect(isOpenAiModelListBody(body)).toBe(false);
    expect(isLocalProviderProbeOutputHealthy(MODELS_ENDPOINT, body)).toBe(false);
  });

  it("accepts an OpenAI-style model list, even when empty", () => {
    expect(isOpenAiModelListBody('{"data":[]}')).toBe(true);
    expect(isLocalProviderProbeOutputHealthy(MODELS_ENDPOINT, '{"data":[{"id":"m"}]}\n')).toBe(
      true,
    );
  });

  it("keeps Ollama tag probes and status-code probes unchanged", () => {
    expect(isLocalProviderProbeOutputHealthy("http://127.0.0.1:11434/api/tags", "401")).toBe(true);
    expect(isLocalProviderProbeOutputHealthy("http://10.40.0.1:8000/health", "200")).toBe(true);
  });

  it("does not report NIM healthy for a non-model-list page and checks the container", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inspectContainerState = vi.fn(() => "exited");

    expect(
      waitForNimHealth(9000, 60, {
        container: "nemoclaw-nim-test",
        runCaptureImpl: () => "<html>dev server</html>",
        inspectContainerState,
        readContainerLogs: () => "",
      }),
    ).toBe(false);
    expect(inspectContainerState).toHaveBeenCalledTimes(1);
  });

  it("reports NIM healthy when the port returns a model list", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(waitForNimHealth(9000, 60, { runCaptureImpl: () => '{"data":[]}' })).toBe(true);
  });
});
