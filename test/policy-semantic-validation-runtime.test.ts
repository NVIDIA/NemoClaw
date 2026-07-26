// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runCapture } = vi.hoisted(() => ({ runCapture: vi.fn() }));

vi.mock("../src/lib/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/runner")>()),
  runCapture,
}));

import { applyPresetContent, loadPresetFromFile } from "../src/lib/policy";

const tempDirs: string[] = [];

beforeEach(() => {
  runCapture.mockReset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("custom policy semantic validation", () => {
  it("rejects unsafe in-memory content before reading the sandbox policy", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        applyPresetContent(
          "alpha",
          "unsafe-egress",
          [
            "preset:",
            "  name: unsafe-egress",
            "network_policies:",
            "  unsafe-egress:",
            "    endpoints:",
            '      - host: "*:443"',
            "        port: 443",
          ].join("\n"),
          { custom: {} },
        ),
      ).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("*:443"));
      expect(runCapture).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rejects a custom preset file with a catch-all host", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preset-"));
    tempDirs.push(dir);
    const file = path.join(dir, "unsafe.yaml");
    fs.writeFileSync(
      file,
      [
        "preset:",
        "  name: unsafe-egress",
        "  description: unsafe",
        "network_policies:",
        "  unsafe-egress:",
        "    name: unsafe-egress",
        "    endpoints:",
        "      - host: 0.0.0.0/0",
        "        port: 443",
      ].join("\n"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadPresetFromFile(file)).toBe(null);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("0.0.0.0/0"));
    } finally {
      errSpy.mockRestore();
    }
  });
});
