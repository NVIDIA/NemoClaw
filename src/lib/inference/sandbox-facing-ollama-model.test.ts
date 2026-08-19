// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OLLAMA_PORT } from "../core/ports";
import {
  getLocalProviderContainerReachabilityCheck,
  ollamaInventoryContainsModel,
  probeOllamaEndpointInventory,
  resetOllamaContainerPortCache,
  resetOllamaHostCache,
  setResolvedOllamaHost,
  validateSandboxFacingOllamaModel,
} from "./local";

const containerCanReachHostLoopback = vi.fn((..._args: unknown[]) => true);

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  containerCanReachHostLoopback: (...args: unknown[]) => containerCanReachHostLoopback(...args),
}));

vi.mock("../adapters/docker/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/runtime")>()),
  detectContainerRuntimeFromDockerInfo: () => "docker-desktop",
}));

function tagsBody(...models: string[]): string {
  return JSON.stringify({ models: models.map((name) => ({ name })) });
}

function commandUrl(command: readonly string[]): string {
  return command.find((arg) => arg.startsWith("http://")) ?? "";
}

describe("sandbox-facing Ollama model validation", () => {
  beforeEach(() => {
    containerCanReachHostLoopback.mockReturnValue(true);
    resetOllamaContainerPortCache();
    resetOllamaHostCache();
    setResolvedOllamaHost("127.0.0.1");
  });

  afterEach(() => {
    resetOllamaContainerPortCache();
    resetOllamaHostCache();
  });

  it("asks the sandbox host bridge for its inventory", () => {
    const command = getLocalProviderContainerReachabilityCheck("ollama-local", "body");

    expect(command).not.toBeNull();
    expect(commandUrl(command ?? [])).toBe(
      `http://host.openshell.internal:${OLLAMA_PORT}/api/tags`,
    );
    expect(command).toContain("--add-host");
    expect(command).toContain("host.openshell.internal:host-gateway");
  });

  it("does not probe when the auth proxy fronts Ollama", () => {
    containerCanReachHostLoopback.mockReturnValue(false);
    resetOllamaContainerPortCache();

    expect(getLocalProviderContainerReachabilityCheck("ollama-local", "body")).toBeNull();
    expect(validateSandboxFacingOllamaModel("llama3.2:1b", () => "")).toEqual({ ok: true });
  });

  it("rejects a model the probed endpoint reports as unavailable (#9454)", () => {
    const result = validateSandboxFacingOllamaModel("llama3.2:1b", () =>
      tagsBody("qwen3.5:2b", "gemma4:26b"),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Selected Ollama model 'llama3.2:1b'");
    expect(result.message).toContain(`http://127.0.0.1:${OLLAMA_PORT}`);
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

    const inventory = probeOllamaEndpointInventory("host.docker.internal", capture);

    expect(commandUrl(capture.mock.calls[0][0])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/tags`,
    );
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
