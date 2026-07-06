// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const onboardSession = requireDist("../../state/onboard-session.js");
const { prepareRebuildResumeConfig } = requireDist("./rebuild-resume-config.js");

const noopLog = () => undefined;
const throwingBail = (message: string): never => {
  throw new Error(message);
};
const entry = (overrides: Record<string, unknown> = {}) => ({
  name: "alpha",
  provider: "compatible-endpoint",
  model: "m",
  nimContainer: null,
  endpointUrl: "https://registry.example.test/v1",
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rebuild resume compatible-endpoint reasoning", () => {
  it("preserves reasoning only for the matching sandbox inference selection", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "m",
      endpointUrl: "https://session.example.test/v1",
      compatibleEndpointReasoning: "true",
    });

    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({ endpointUrl: null }),
      null,
      noopLog,
      throwingBail,
    );

    expect(config?.compatibleEndpointReasoning).toBe("true");
    expect(config?.endpointUrl).toBe("https://session.example.test/v1");
  });

  it.each([
    { provider: "openai-api", model: "m" },
    { provider: "compatible-endpoint", model: "other-model" },
  ])("clears reasoning from a same-name session with stale $provider/$model", (selection) => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      endpointUrl: "https://session.example.test/v1",
      compatibleEndpointReasoning: "true",
      ...selection,
    });

    expect(
      prepareRebuildResumeConfig("alpha", entry(), null, noopLog, throwingBail)
        ?.compatibleEndpointReasoning,
    ).toBeNull();
  });

  it("clears reasoning owned by an unrelated sandbox session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "other",
      compatibleEndpointReasoning: "true",
    });

    expect(
      prepareRebuildResumeConfig("alpha", entry(), null, noopLog, throwingBail)
        ?.compatibleEndpointReasoning,
    ).toBeNull();
  });
});
