// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as nim from "../../inference/nim";
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
});
