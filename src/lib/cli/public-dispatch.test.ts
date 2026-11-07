// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const { getRegisteredOclifCommandMetadataMock } = vi.hoisted(() => ({
  getRegisteredOclifCommandMetadataMock: vi.fn(),
}));

vi.mock("./oclif-metadata", () => ({
  getRegisteredOclifCommandMetadata: getRegisteredOclifCommandMetadataMock,
}));

import { shouldExecuteViaNativeArgv } from "./public-dispatch";

function nativeArgvResult(commandId: string, args: string[]) {
  return { kind: "nativeArgv" as const, commandId, args, argv: [] };
}

describe("shouldExecuteViaNativeArgv", () => {
  it("falls through to native argv for a --help request on a topic-only command id", () => {
    // "sandbox:policy" only registers children (e.g. "sandbox:policy:add"), not itself.
    getRegisteredOclifCommandMetadataMock.mockReturnValue(null);

    expect(shouldExecuteViaNativeArgv(nativeArgvResult("sandbox:policy", ["--help"]))).toBe(true);
  });

  it("uses direct dispatch for a --help request on a registered exact command id", () => {
    getRegisteredOclifCommandMetadataMock.mockReturnValue({ summary: "stub" });

    expect(shouldExecuteViaNativeArgv(nativeArgvResult("sandbox:destroy", ["--help"]))).toBe(false);
  });

  it("uses direct dispatch for root-namespaced command ids regardless of registration", () => {
    getRegisteredOclifCommandMetadataMock.mockReturnValue(null);

    expect(shouldExecuteViaNativeArgv(nativeArgvResult("root:list", []))).toBe(false);
  });

  it("falls through to native argv for an unregistered, non-help command id", () => {
    getRegisteredOclifCommandMetadataMock.mockReturnValue(null);

    expect(shouldExecuteViaNativeArgv(nativeArgvResult("sandbox:unknown-child", []))).toBe(true);
  });
});
