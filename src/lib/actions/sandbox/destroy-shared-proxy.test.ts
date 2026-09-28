// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as nim from "../../inference/nim";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { SandboxEntry } from "../../state/registry";
import { stopSandboxInferenceResources } from "./destroy-preflight";

describe("destroy shared Ollama proxy cleanup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the proxy while another sandbox owns its credential route", () => {
    const target = { name: "alpha", provider: "ollama-local" } as SandboxEntry;
    const peer = {
      name: "beta",
      provider: "compatible-endpoint",
      endpointUrl: "http://localhost:11434/v1",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    } as SandboxEntry;
    const killStaleProxyIfUnused = vi.fn((hasRemainingOwner: () => boolean) => {
      return !hasRemainingOwner();
    });
    vi.spyOn(nim, "stopNimContainer").mockReturnValue(true);

    stopSandboxInferenceResources(
      "alpha",
      target,
      () => ({
        sandboxes: [target, peer],
        defaultSandbox: "alpha",
      }),
      { killStaleProxyIfUnused },
    );

    expect(killStaleProxyIfUnused).toHaveBeenCalledOnce();
    expect(killStaleProxyIfUnused.mock.calls[0]?.[0]()).toBe(true);
  });

  it.each(["compatible-endpoint", "compatible-anthropic-endpoint"])(
    "stops the shared proxy after its final %s owner is removed",
    (provider) => {
      const ollama = { name: "alpha", provider: "ollama-local" } as SandboxEntry;
      const compatible = {
        name: "beta",
        provider,
        credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
      } as SandboxEntry;
      let sandboxes = [ollama, compatible];
      let proxyRunning = true;
      const killStaleProxyIfUnused = vi.fn((hasRemainingOwner: () => boolean) => {
        proxyRunning = hasRemainingOwner();
        return !proxyRunning;
      });
      const listSandboxes = () => ({ sandboxes, defaultSandbox: "beta" });
      vi.spyOn(nim, "stopNimContainer").mockReturnValue(true);

      stopSandboxInferenceResources("beta", compatible, listSandboxes, { killStaleProxyIfUnused });
      expect(proxyRunning).toBe(true);
      stopSandboxInferenceResources("alpha", ollama, listSandboxes, { killStaleProxyIfUnused });
      expect(proxyRunning).toBe(true);
      sandboxes = [compatible];
      stopSandboxInferenceResources("beta", compatible, listSandboxes, { killStaleProxyIfUnused });
      expect(proxyRunning).toBe(false);
      expect(killStaleProxyIfUnused).toHaveBeenCalledTimes(3);
    },
  );

  it("does not clean up the proxy for an authenticated compatible endpoint", () => {
    const target = {
      name: "authenticated",
      provider: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
    } as SandboxEntry;
    const killStaleProxyIfUnused = vi.fn();
    vi.spyOn(nim, "stopNimContainer").mockReturnValue(true);

    stopSandboxInferenceResources(
      target.name,
      target,
      () => ({ sandboxes: [target], defaultSandbox: target.name }),
      { killStaleProxyIfUnused },
    );

    expect(killStaleProxyIfUnused).not.toHaveBeenCalled();
  });
});
