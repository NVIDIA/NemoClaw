// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { serializedHostLocalInferenceReceipt } from "./helpers/host-local-inference-receipt";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-local-registry-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const registry = require("../src/lib/state/registry");
const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

beforeEach(() => {
  if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
});

describe("registry host-local inference authority", () => {
  it("round-trips a canonical receipt without rewriting it", () => {
    const receipt = serializedHostLocalInferenceReceipt();
    registry.registerSandbox({
      name: "host-local",
      hostLocalInferenceReceipt: receipt,
    });

    expect(registry.getSandbox("host-local").hostLocalInferenceReceipt).toBe(receipt);
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes["host-local"].hostLocalInferenceReceipt).toBe(receipt);
  });

  it("rejects malformed receipt transports on load and save", () => {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(
      regFile,
      JSON.stringify({
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: { name: "alpha", hostLocalInferenceReceipt: '{"providerId": "mxc"}\n' },
        },
      }),
    );
    expect(() => registry.getSandbox("alpha")).toThrow(/invalid host-local inference receipt/);

    fs.rmSync(regFile, { force: true });
    expect(() =>
      registry.save({
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: { name: "alpha", hostLocalInferenceReceipt: "not-json\n" },
        },
      }),
    ).toThrow(/invalid host-local inference receipt/);
    expect(fs.existsSync(regFile)).toBe(false);
  });
});
