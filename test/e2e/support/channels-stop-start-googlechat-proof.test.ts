// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertGooglechatProviderEgressProof,
  parseGooglechatProviderEgressProof,
} from "../live/channels-stop-start-googlechat-proof.ts";

describe("channels stop/start Google Chat provider-egress proof", () => {
  it.each([
    {
      agent: "openclaw" as const,
      proof: { placeholder: "revision-scoped", statuses: [401] },
    },
    {
      agent: "hermes" as const,
      proof: { installedOverride: true, placeholder: "revision-scoped", statuses: [401, 401] },
    },
  ])("accepts the $agent provider-egress proof", ({ agent, proof }) => {
    const stdout = `runtime noise\n${JSON.stringify(proof)}\n`;

    expect(() =>
      assertGooglechatProviderEgressProof(parseGooglechatProviderEgressProof(stdout), agent),
    ).not.toThrow();
  });

  it("rejects malformed proof output", () => {
    expect(() => parseGooglechatProviderEgressProof("runtime noise\nnot-json\n")).toThrow();
  });

  it.each([
    {
      agent: "openclaw" as const,
      proof: { placeholder: "raw-token", statuses: [401] },
      title: "a non-revision-scoped placeholder marker",
    },
    {
      agent: "openclaw" as const,
      proof: { placeholder: "revision-scoped", statuses: [403] },
      title: "an unexpected OpenClaw API status",
    },
    {
      agent: "hermes" as const,
      proof: { installedOverride: true, placeholder: "revision-scoped", statuses: [401] },
      title: "an incomplete Hermes API status sequence",
    },
    {
      agent: "hermes" as const,
      proof: { installedOverride: false, placeholder: "revision-scoped", statuses: [401, 401] },
      title: "a missing Hermes adapter override",
    },
  ])("rejects $title", ({ agent, proof }) => {
    expect(() => assertGooglechatProviderEgressProof(proof, agent)).toThrow();
  });
});
