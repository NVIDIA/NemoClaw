// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import { HERMES_LIFECYCLE_DEFINITION } from "./hermes-definition";

describe("Hermes lifecycle definition", () => {
  it("matches the packaged Hermes manifest version (#10613)", () => {
    const hermes = loadAgent("hermes");

    expect(HERMES_LIFECYCLE_DEFINITION).toEqual({
      agent: hermes.name,
      agentVersion: hermes.expectedVersion,
      openshellVersion: "0.0.106",
    });
  });
});
