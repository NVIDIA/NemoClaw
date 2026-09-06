// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as policies from "../../policy";
import { addSandboxPolicy } from "./policy-channel";
import * as policyContextRefresh from "./policy-context-refresh";

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let tempDir: string;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let applyPresetContentSpy: MockInstance;
let refreshSpy: MockInstance;

function writePreset(name: string, content: string): string {
  const file = path.join(tempDir, `${name}.yaml`);
  fs.writeFileSync(file, content);
  return file;
}

function printedText(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
}

async function captureExit(action: () => Promise<void>): Promise<number | undefined> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ExitError);
    return (error as ExitError).code;
  }
  throw new Error("Expected process.exit to be called");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-custom-dry-run-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
  applyPresetContentSpy = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
  refreshSpy = vi
    .spyOn(policyContextRefresh, "refreshSandboxPolicyContextFile")
    .mockReturnValue({ outcome: "ok", written: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("policy add --from-file --dry-run custom preset validation", () => {
  it.each([
    ["npm_yarn", "npm-yarn"],
    ["personal_open_internet", "personal-open-internet"],
  ])("rejects reserved key %s before preview or policy mutation (#10773)", async (key, name) => {
    const file = writePreset(
      name,
      `preset:
  name: qa-${name}
network_policies:
  ${key}:
    endpoints:
      - host: api.example.com
        port: 443
`,
    );

    await expect(
      captureExit(() => addSandboxPolicy("test-sandbox", { fromFile: file, dryRun: true })),
    ).resolves.toBe(1);

    expect(printedText()).toContain(
      `Custom presets cannot own reserved network policy key '${key}'.`,
    );
    expect(printedText()).not.toContain("Effective egress that would be opened:");
    expect(applyPresetContentSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("rejects allowed_ips before preview or policy mutation (#10773)", async () => {
    const file = writePreset(
      "allowed-ips",
      `preset:
  name: qa-allowed-ips
network_policies:
  custom:
    endpoints:
      - host: api.example.com
        port: 443
        allowed_ips:
          - 192.0.2.1
`,
    );

    await expect(
      captureExit(() => addSandboxPolicy("test-sandbox", { fromFile: file, dryRun: true })),
    ).resolves.toBe(1);

    expect(printedText()).toContain("contains 'allowed_ips'");
    expect(printedText()).not.toContain("Effective egress that would be opened:");
    expect(applyPresetContentSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("previews a valid custom preset without policy mutation (#10773)", async () => {
    const file = writePreset(
      "valid",
      `preset:
  name: qa-valid
network_policies:
  custom:
    endpoints:
      - host: api.example.com
        port: 443
`,
    );

    await addSandboxPolicy("test-sandbox", { fromFile: file, dryRun: true });

    expect(printedText()).toContain("Effective egress that would be opened:");
    expect(printedText()).toContain("--dry-run: 'qa-valid' not applied.");
    expect(applyPresetContentSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
