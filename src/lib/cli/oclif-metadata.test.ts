// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getRegisteredOclifCommandMetadata,
  getRegisteredOclifCommandSummary,
} from "./oclif-metadata";

describe("oclif metadata lookup", () => {
  it("returns registered command summaries", () => {
    expect(getRegisteredOclifCommandSummary("sandbox:logs")).toBe("Stream sandbox logs");
  });

  it("returns null for unknown command IDs", () => {
    expect(getRegisteredOclifCommandMetadata("missing:nope")).toBeNull();
  });
});
