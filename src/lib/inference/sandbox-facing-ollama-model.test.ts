// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OLLAMA_PORT, OLLAMA_PROXY_PORT } from "../core/ports";
import {
  getOllamaContainerPort,
  getLocalProviderContainerReachabilityCheck,
  ollamaInventoryContainsModel,
  OLLAMA_HOST_DOCKER_INTERNAL,
  probeOllamaEndpointInventory,
  resetOllamaHostCache,
  setResolvedOllamaHost,
  shouldFrontOllamaWithProxy,
  validateSandboxFacingOllamaModel,
} from "./local";

function tagsBody(...models: string[]): string {
  return JSON.stringify({ models: models.map((name) => ({ name })) });
}

function commandUrl(command: readonly string[]): string {
  return command.find((arg) => arg.startsWith("http://")) ?? "";
}

describe("sandbox-facing Ollama model validation", () => {
  beforeEach(() => {
    resetOllamaHostCache();
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
  });

  afterEach(() => {
    resetOllamaHostCache();
  });

  it("uses the raw bridge for the selected Windows-host route", () => {
    const command = getLocalProviderContainerReachabilityCheck("ollama-local", "body");

    expect(getOllamaContainerPort()).toBe(OLLAMA_PORT);
    expect(shouldFrontOllamaWithProxy()).toBe(false);
    expect(command).not.toBeNull();
    expect(commandUrl(command ?? [])).toBe(
      `http://host.openshell.internal:${OLLAMA_PORT}/api/tags`,
    );
    expect(command).toContain("--add-host");
    expect(command).toContain("host.openshell.internal:host-gateway");
  });

  it("uses the auth proxy for a WSL-local route", () => {
    const capture = vi.fn(() => "");
    setResolvedOllamaHost("127.0.0.1");

    expect(getOllamaContainerPort()).toBe(OLLAMA_PROXY_PORT);
    expect(shouldFrontOllamaWithProxy()).toBe(true);
    expect(getLocalProviderContainerReachabilityCheck("ollama-local", "body")).toBeNull();
    expect(validateSandboxFacingOllamaModel("llama3.2:1b", capture)).toEqual({ ok: true });
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects a model the probed endpoint reports as unavailable (#9454)", () => {
    const result = validateSandboxFacingOllamaModel("llama3.2:1b", () =>
      tagsBody("qwen3.5:2b", "gemma4:26b"),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Selected Ollama model 'llama3.2:1b'");
    expect(result.message).toContain(`http://${OLLAMA_HOST_DOCKER_INTERNAL}:${OLLAMA_PORT}`);
    expect(result.message).toContain(`http://host.openshell.internal:${OLLAMA_PORT}`);
    expect(result.message).toContain("reported models: qwen3.5:2b, gemma4:26b");
  });

  it("accepts a model the sandbox endpoint serves, including the implicit latest tag", () => {
    expect(validateSandboxFacingOllamaModel("llama3.2:1b", () => tagsBody("llama3.2:1b"))).toEqual({
      ok: true,
    });
    expect(validateSandboxFacingOllamaModel("llama3.2", () => tagsBody("llama3.2:latest"))).toEqual(
      {
        ok: true,
      },
    );
  });

  it.each([
    ["an unreachable endpoint", ""],
    ["a non-Ollama body", "<html>proxy</html>"],
    ["a JSON body without a models array", JSON.stringify({ error: "nope" })],
    ["an inventory with a malformed model entry", JSON.stringify({ models: [{}] })],
    ["an inventory with a whitespace-only model name", tagsBody("   ")],
  ])("never fails onboarding on %s", (_name, body) => {
    expect(validateSandboxFacingOllamaModel("llama3.2:1b", () => body)).toEqual({ ok: true });
  });

  it("returns ok when no model is selected", () => {
    const capture = vi.fn(() => tagsBody());

    expect(validateSandboxFacingOllamaModel("   ", capture)).toEqual({ ok: true });
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("Ollama model inventory", () => {
  it("queries the given daemon for its inventory", () => {
    const capture = vi.fn((_command: readonly string[]) => tagsBody("llama3.2:1b"));

    const inventory = probeOllamaEndpointInventory("127.0.0.1", capture);

    expect(commandUrl(capture.mock.calls[0][0])).toBe(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`);
    expect(inventory).toEqual(["llama3.2:1b"]);
    expect(ollamaInventoryContainsModel(inventory ?? [], "gemma4:26b")).toBe(false);
  });

  it("matches a served model", () => {
    const inventory = probeOllamaEndpointInventory("127.0.0.1", () => tagsBody("gemma4:26b"));
    expect(ollamaInventoryContainsModel(inventory ?? [], "gemma4:26b")).toBe(true);
  });

  it("returns null for an unreadable inventory", () => {
    expect(probeOllamaEndpointInventory("127.0.0.1", () => "")).toBeNull();
  });

  it("keeps a valid empty inventory authoritative", () => {
    expect(probeOllamaEndpointInventory("127.0.0.1", () => tagsBody())).toEqual([]);
  });
});
