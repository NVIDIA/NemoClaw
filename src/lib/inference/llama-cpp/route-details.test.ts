// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getLlamaCppRouteDetails } from "../config";

describe("getLlamaCppRouteDetails", () => {
  it("reports the fixed endpoint for an attached llama.cpp route (#10256)", () => {
    expect(
      getLlamaCppRouteDetails(
        {
          name: "attached",
          provider: "llama-cpp-local",
          endpointUrl: "http://127.0.0.1:8081/v1",
        } as never,
        () => "absent",
      ),
    ).toEqual({ kind: "attached", endpointUrl: "http://127.0.0.1:8081/v1" });
  });

  it("reports a managed route from its durable ownership receipt (#10256)", () => {
    expect(
      getLlamaCppRouteDetails(
        {
          name: "managed",
          provider: "llama-cpp-local",
          endpointUrl: "http://127.0.0.1:8081/v1",
        } as never,
        () => "owned",
      ),
    ).toEqual({ kind: "managed" });
  });

  it.each([
    { servingProfileProvenance: { recipe: { backend: "install-llama-cpp" } } },
    { hostLocalInferenceProvenance: {} },
  ])("reports managed ownership from persisted provenance %#", (provenance) => {
    expect(
      getLlamaCppRouteDetails(
        { name: "managed", provider: "llama-cpp-local", ...provenance } as never,
        () => "absent",
      ),
    ).toEqual({ kind: "managed" });
  });

  it("reports unavailable ownership without exposing the endpoint", () => {
    expect(
      getLlamaCppRouteDetails(
        {
          name: "managed",
          provider: "llama-cpp-local",
          endpointUrl: "http://127.0.0.1:8081/v1",
        } as never,
        () => "unknown",
      ),
    ).toEqual({
      kind: "unavailable",
      diagnostic: "Managed llama.cpp ownership state is unavailable.",
      recovery: "Run nemoclaw doctor and correct the reported state before retrying.",
    });
  });

  it("does not expose an unrecognized endpoint", () => {
    expect(
      getLlamaCppRouteDetails(
        {
          name: "unrecognized",
          provider: "llama-cpp-local",
          endpointUrl: "http://127.0.0.1:8081/v1?token=secret",
        } as never,
        () => "absent",
      ),
    ).toBeNull();
  });
});
