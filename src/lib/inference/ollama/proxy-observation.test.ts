// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWsl } from "../../platform";
import { observeOllamaProxy, type OllamaProxyObservationInput } from "./proxy-observation";

vi.mock("../../platform", () => ({ isWsl: vi.fn(() => false) }));

const digest = "a".repeat(64);
const active = {
  schemaVersion: 1,
  pid: 1234,
  listener: { address: "0.0.0.0", port: 11440 },
  backendOrigin: "http://127.0.0.1:11439",
};
const models = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest, size: 6000000000 }] });
function observation(): OllamaProxyObservationInput {
  return {
    model: "qwen3.5:9b",
    backend: { kind: "ollama", url: active.backendOrigin },
    proxyPort: "11440",
    pid: "1234",
    processMatches: vi.fn(() => true),
    readActiveConfig: vi.fn(() => JSON.stringify(active)),
    readProxyModels: vi.fn(() => models),
    readDaemonModels: vi.fn(() => models),
  };
}

describe("read-only Ollama export observation", () => {
  beforeEach(() => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.mocked(isWsl).mockReturnValue(false);
  });

  it.each([
    { platform: "darwin", wsl: false },
    { platform: "linux", wsl: true },
  ] as const)("refuses unsupported host facts before protected reads %# (#11435)", (host) => {
    vi.spyOn(os, "platform").mockReturnValue(host.platform);
    vi.mocked(isWsl).mockReturnValue(host.wsl);
    const input = observation();
    expect(() => observeOllamaProxy(input)).toThrow("requires a native Linux host");
    expect(input.readActiveConfig).not.toHaveBeenCalled();
    expect(input.readProxyModels).not.toHaveBeenCalled();
    expect(input.readDaemonModels).not.toHaveBeenCalled();
  });

  it("exports the active nondefault mapping and attached model identity (#11435)", () => {
    const input = observation();
    expect(observeOllamaProxy(input)).toEqual({
      pid: 1234,
      listenerAddress: "0.0.0.0",
      serving: {
        backend: "ollama",
        daemon: { management: "external", hostPort: 11439 },
        proxy: { management: "nemoclaw", hostPort: 11440 },
        model: { servedName: "qwen3.5:9b", digest: `sha256:${digest}` },
      },
    });
    expect(input.readActiveConfig).toHaveBeenCalledWith(11440);
    expect(input.readProxyModels).toHaveBeenCalledWith(11440);
    expect(input.readDaemonModels).toHaveBeenCalledWith(11439);
  });

  it.each([
    { backend: { kind: "compatible", url: active.backendOrigin } },
    { backend: { kind: "ollama", url: "http://127.0.0.1:11439/private?secret" } },
    { backend: { kind: "ollama", url: "http://remote.example:11439" } },
    { proxyPort: "11439" },
    { proxyPort: null },
    { proxyPort: "011440" },
    { pid: null },
    { pid: "-1" },
    { pid: "1234junk" },
    { model: "different:tag" },
    { processMatches: () => false },
  ])(
    "refuses unsupported or incomplete retained intent before network reads %# (#11435)",
    (change) => {
      const input = { ...observation(), ...change };
      expect(() => observeOllamaProxy(input)).toThrow("could not be verified");
      expect(input.readActiveConfig).not.toHaveBeenCalled();
      expect(input.readProxyModels).not.toHaveBeenCalled();
      expect(input.readDaemonModels).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "legacy proxy response",
    JSON.stringify({ error: "not found" }),
    "a".repeat(65537),
    JSON.stringify({ ...active, pid: 1235 }),
    JSON.stringify({ ...active, listener: { address: "127.0.0.1", port: 11440 } }),
    JSON.stringify({ ...active, listener: { address: "0.0.0.0", port: 11435 } }),
    JSON.stringify({ ...active, backendOrigin: "http://127.0.0.1:11434" }),
    JSON.stringify({ ...active, backendOrigin: "http://user:secret@127.0.0.1:11439/private" }),
  ])("refuses a missing or mismatched active response without guessing %# (#11435)", (body) => {
    const input = { ...observation(), readActiveConfig: () => body };
    expect(() => observeOllamaProxy(input)).toThrow("could not be verified");
    expect(input.readProxyModels).not.toHaveBeenCalled();
  });

  it.each([
    { models: [] },
    { models: [{ name: "qwen3.5:9b", digest: "invalid" }] },
    { models: [{ name: "other:tag", digest }] },
    {
      models: [
        { name: "qwen3.5:9b", digest },
        { name: "qwen3.5:9b", digest },
      ],
    },
    { models: [{ name: "qwen3.5:9b", digest: "b".repeat(64) }] },
  ])("refuses a missing, ambiguous, or changed daemon model %# (#11435)", (value) => {
    expect(() =>
      observeOllamaProxy({ ...observation(), readDaemonModels: () => JSON.stringify(value) }),
    ).toThrow("could not be verified");
  });
});
