// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  managedPolicyInspection,
  managedSandboxEntry,
  SANDBOX_IDENTITY,
} from "../../helpers/managed-policy-receipt-fixture";

const {
  getSandbox,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  runCapture,
} = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  inspectOpenShellSandboxIdentityFingerprint: vi.fn(),
  inspectSandboxPolicyAuthority: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../../../src/lib/adapters/openshell/policy-authority", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/lib/adapters/openshell/policy-authority")
  >()),
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
}));

vi.mock("../../../src/lib/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/runner")>()),
  runCapture,
}));

vi.mock("../../../src/lib/state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/state/registry")>()),
  getSandbox,
}));

import { applyPresetContent, loadPreset, loadPresetFromFile } from "../../../src/lib/policy";

const tempDirs: string[] = [];
const DRIFTED_PERSONAL_POLICY = `version: 1
network_policies:
  personal_open_internet:
    name: personal_open_internet
    endpoints:
      - ports: [80, 443]
        allowed_ips: [8.8.8.8]
    binaries:
      - path: /**
`;

beforeEach(() => {
  getSandbox.mockReset();
  getSandbox.mockImplementation((name: string) => managedSandboxEntry(name));
  inspectSandboxPolicyAuthority.mockReset();
  inspectSandboxPolicyAuthority.mockReturnValue(managedPolicyInspection());
  inspectOpenShellSandboxIdentityFingerprint.mockReset();
  inspectOpenShellSandboxIdentityFingerprint.mockReturnValue(SANDBOX_IDENTITY);
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

describe("Personal policy mutation validation", () => {
  it("returns false for non-fatal application when the reserved Personal entry drifts", () => {
    runCapture.mockReturnValue(DRIFTED_PERSONAL_POLICY);
    const weatherPreset = loadPreset("weather");
    expect(weatherPreset).not.toBeNull();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(
        applyPresetContent("personal-drift", "weather", weatherPreset!, {
          nonFatal: true,
        }),
      ).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("does not match the reviewed built-in preset"),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("throws for ordinary application when the reserved Personal entry drifts", () => {
    runCapture.mockReturnValue(DRIFTED_PERSONAL_POLICY);
    const weatherPreset = loadPreset("weather");
    expect(weatherPreset).not.toBeNull();

    expect(() => applyPresetContent("personal-drift", "weather", weatherPreset!)).toThrow(
      "does not match the reviewed built-in preset",
    );
  });
});
