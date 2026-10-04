// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { expectedServedModelId } from "./nim";

describe("NIM route identity", () => {
  it("uses durable served IDs when they differ from catalog IDs (#6315)", () => {
    expect(expectedServedModelId("nvidia/nemotron-3-nano-30b-a3b")).toBe("nvidia/nemotron-3-nano");
    expect(expectedServedModelId("meta/llama-3.1-8b-instruct")).toBe("meta/llama-3.1-8b-instruct");
  });
});
