// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  managedPolicyInspection,
  managedSandboxEntry,
  SANDBOX_IDENTITY,
} from "../../../test/helpers/managed-policy-receipt-fixture";

const {
  addCustomPolicy,
  getSandbox,
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
  resolveOpenshell,
  run,
  runCapture,
  updateSandbox,
} = vi.hoisted(() => ({
  addCustomPolicy: vi.fn(),
  getSandbox: vi.fn(),
  inspectOpenShellSandboxIdentityFingerprint: vi.fn(),
  inspectSandboxPolicyAuthority: vi.fn(),
  resolveOpenshell: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
  updateSandbox: vi.fn(),
}));

vi.mock("../adapters/openshell/policy-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/policy-authority")>()),
  inspectOpenShellSandboxIdentityFingerprint,
  inspectSandboxPolicyAuthority,
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run,
  runCapture,
}));

vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  addCustomPolicy,
  getSandbox,
  updateSandbox,
}));

vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell,
}));

import { applyPresetContent, applyPresets, removePreset } from "./index";

const SANDBOX = "finality-9206";

/** A round-trippable base policy that does not yet carry the weather preset. */
const BASE_POLICY = `version: 1
network_policies:
  nvidia:
    name: nvidia
    endpoints:
      - host: api.nvidia.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
`;

/** The same base policy after the weather preset has been applied to it. */
const BASE_POLICY_WITH_WEATHER = `${BASE_POLICY}  weather:
    name: weather
    endpoints:
      - host: wttr.in
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
`;

/** Minimal preset content for the single-preset apply path. */
const WEATHER_PRESET_CONTENT = `preset:
  name: weather
  description: "Read-only public weather"

network_policies:
  weather:
    name: weather
    endpoints:
      - host: wttr.in
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
`;

/**
 * A credential-shaped token an OpenShell diagnostic could echo back out of the
 * policy document it was handed.
 */
const CREDENTIAL_TOKEN = "nvapi-abcdefghijklmnopqrstuvwxyz";

/** A synthetic `code:`/`message:` frame the classifier accepts as a refusal. */
function openshellRejection(message: string): string {
  return (
    `Error: code: 'Failed precondition', message: '${message}', ` +
    "source: tonic::Status { code: FailedPrecondition, grpc_status: 9 }"
  );
}

function policySetResult(stderr: string): SpawnSyncReturns<string | Buffer> {
  return {
    pid: 4242,
    output: [null, Buffer.alloc(0), Buffer.from(stderr, "utf-8")],
    stdout: Buffer.alloc(0),
    // `run` never passes an encoding, so spawnSync hands stderr back as a Buffer.
    stderr: Buffer.from(stderr, "utf-8"),
    status: 1,
    signal: null,
  };
}

function reportedText(): string {
  return vi
    .mocked(console.error)
    .mock.calls.flat()
    .map((entry) => String(entry))
    .join("\n");
}

function applyWeatherPreset(): unknown {
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)}): ${reportedText()}`);
  });
  try {
    applyPresets(SANDBOX, ["weather"]);
    return null;
  } catch (error) {
    return error;
  } finally {
    exit.mockRestore();
  }
}

function removeTemporaryDirectory(directory: string, removeDirectory: typeof fs.rmSync): void {
  removeDirectory(directory, { recursive: true, force: true });
}

describe("applyPresets finality when openshell rejects the composed policy", () => {
  beforeEach(() => {
    run.mockReset();
    runCapture.mockReset();
    getSandbox.mockReset();
    inspectOpenShellSandboxIdentityFingerprint.mockReset();
    inspectSandboxPolicyAuthority.mockReset();
    updateSandbox.mockReset();
    addCustomPolicy.mockReset();
    resolveOpenshell.mockReset();

    resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    inspectOpenShellSandboxIdentityFingerprint.mockReturnValue(SANDBOX_IDENTITY);
    inspectSandboxPolicyAuthority.mockReturnValue(managedPolicyInspection());
    runCapture.mockReturnValue(BASE_POLICY);
    getSandbox.mockReturnValue(managedSandboxEntry(SANDBOX));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("surfaces the authoritative OpenShell message rather than a bare exit status (#9206)", () => {
    const message = 'network policy "weather" rejected: endpoint wttr.in conflicts with baseline';
    run.mockReturnValue(policySetResult(openshellRejection(message)));

    const error = applyWeatherPreset();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).toContain("exit 1");
    expect((error as Error).message).not.toMatch(/^exit 1$/);
  });

  it("redacts a credential-shaped token in the OpenShell message before reporting it (#9206)", () => {
    run.mockReturnValue(
      policySetResult(openshellRejection(`rejected: header carries ${CREDENTIAL_TOKEN}`)),
    );

    const error = applyWeatherPreset();

    expect((error as Error).message).not.toContain(CREDENTIAL_TOKEN);
    expect((error as Error).message).toContain("nvap");
    const reported = [
      ...vi.mocked(console.error).mock.calls,
      ...vi.mocked(console.log).mock.calls,
    ].flat();
    expect(reported.filter((entry) => String(entry).includes(CREDENTIAL_TOKEN))).toEqual([]);
  });

  it("leaves local preset attribution unwritten when openshell rejects the policy (#9206)", () => {
    run.mockReturnValue(policySetResult(openshellRejection("rejected: unsupported field")));

    expect(applyWeatherPreset()).toBeInstanceOf(Error);
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(addCustomPolicy).not.toHaveBeenCalled();
  });

  it("leaves local preset attribution unwritten when the outcome is unknown (#9206)", () => {
    run.mockReturnValue(
      policySetResult("Error: code: 'Internal error', message: 'h2 protocol error: http2 error'"),
    );

    const error = applyWeatherPreset();

    expect((error as Error).message).toContain("read the current policy back before retrying");
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(addCustomPolicy).not.toHaveBeenCalled();
  });
});

/**
 * The single-preset mutations keep the contract their lifecycle callers were
 * written against: with `nonFatal` they report the failure, return `false`,
 * and leave the compensating action to the caller. Only the leaked temp
 * material and the bare exit status changed (#9206).
 */
describe("single-preset mutations when openshell rejects the composed policy", () => {
  const REJECTION_MESSAGE = "unsupported field in network_policies.weather";

  beforeEach(() => {
    run.mockReset();
    runCapture.mockReset();
    getSandbox.mockReset();
    inspectOpenShellSandboxIdentityFingerprint.mockReset();
    inspectSandboxPolicyAuthority.mockReset();
    updateSandbox.mockReset();
    addCustomPolicy.mockReset();
    resolveOpenshell.mockReset();

    resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    inspectOpenShellSandboxIdentityFingerprint.mockReturnValue(SANDBOX_IDENTITY);
    inspectSandboxPolicyAuthority.mockReturnValue(managedPolicyInspection());
    getSandbox.mockReturnValue({ ...managedSandboxEntry(SANDBOX), policies: ["weather"] });
    run.mockReturnValue(policySetResult(openshellRejection(REJECTION_MESSAGE)));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns false from a nonFatal removePreset and reports the OpenShell message (#9206)", () => {
    runCapture.mockReturnValue(BASE_POLICY_WITH_WEATHER);

    expect(removePreset(SANDBOX, "weather", { nonFatal: true })).toBe(false);
    expect(reportedText()).toContain(REJECTION_MESSAGE);
    expect(reportedText()).toContain("change the preset selection instead");
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("returns false from a nonFatal applyPresetContent and reports the OpenShell message (#9206)", () => {
    runCapture.mockReturnValue(BASE_POLICY);

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET_CONTENT, { nonFatal: true })).toBe(
      false,
    );
    expect(reportedText()).toContain(REJECTION_MESSAGE);
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(addCustomPolicy).not.toHaveBeenCalled();
  });

  it("redacts a credential-shaped token before reporting a nonFatal failure (#9206)", () => {
    runCapture.mockReturnValue(BASE_POLICY);
    run.mockReturnValue(
      policySetResult(openshellRejection(`rejected: header carries ${CREDENTIAL_TOKEN}`)),
    );

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET_CONTENT, { nonFatal: true })).toBe(
      false,
    );
    expect(reportedText()).not.toContain(CREDENTIAL_TOKEN);
  });
});

describe("applyPresets temporary policy material under local I/O failure", () => {
  beforeEach(() => {
    run.mockReset();
    runCapture.mockReset();
    getSandbox.mockReset();
    inspectOpenShellSandboxIdentityFingerprint.mockReset();
    inspectSandboxPolicyAuthority.mockReset();
    updateSandbox.mockReset();
    resolveOpenshell.mockReset();

    resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    inspectOpenShellSandboxIdentityFingerprint.mockReturnValue(SANDBOX_IDENTITY);
    inspectSandboxPolicyAuthority.mockReturnValue(managedPolicyInspection());
    runCapture.mockReturnValue(BASE_POLICY);
    getSandbox.mockReturnValue(managedSandboxEntry(SANDBOX));
    run.mockReturnValue(policySetResult(openshellRejection("refused")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("removes the private directory when the policy document cannot be written (#9206)", () => {
    const created: string[] = [];
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      const dir = `${prefix}fault${created.length}`;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      created.push(dir);
      return dir;
    }) as unknown as typeof fs.mkdtempSync);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    const error = applyWeatherPreset();

    expect(error).toBeInstanceOf(Error);
    expect(created).toHaveLength(1);
    expect(fs.existsSync(created[0] as string)).toBe(false);
  });

  it("names the directory that still holds the composed policy when cleanup fails (#9206)", () => {
    const created: string[] = [];
    const realMkdtemp = fs.mkdtempSync;
    const realRmSync = fs.rmSync;
    const cleanupRoot = realMkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-test-"));
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      const dir = (realMkdtemp as (p: string) => string)(
        path.join(cleanupRoot, path.basename(prefix)),
      );
      created.push(dir);
      return dir;
    }) as unknown as typeof fs.mkdtempSync);
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });

    try {
      const error = applyWeatherPreset();

      expect(created).toHaveLength(1);
      expect((error as Error).message).toContain(created[0] as string);
      expect((error as Error).message).toContain("EPERM: operation not permitted");
    } finally {
      vi.restoreAllMocks();
      removeTemporaryDirectory(cleanupRoot, realRmSync);
    }
  });

  it("reports a residual directory that removal left behind without an error (#9206)", () => {
    const created: string[] = [];
    const realMkdtemp = fs.mkdtempSync;
    const realRmSync = fs.rmSync;
    const cleanupRoot = realMkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-test-"));
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      const dir = (realMkdtemp as (p: string) => string)(
        path.join(cleanupRoot, path.basename(prefix)),
      );
      created.push(dir);
      return dir;
    }) as unknown as typeof fs.mkdtempSync);
    // Removal reports success while the directory survives.
    vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    try {
      const error = applyWeatherPreset();

      expect(created).toHaveLength(1);
      expect((error as Error).message).toContain(created[0] as string);
      expect((error as Error).message).toContain("the path still exists");
    } finally {
      vi.restoreAllMocks();
      removeTemporaryDirectory(cleanupRoot, realRmSync);
    }
  });

  it("reports retained policy material even when the submission itself failed (#9206)", () => {
    const created: string[] = [];
    const realMkdtemp = fs.mkdtempSync;
    const realRmSync = fs.rmSync;
    const cleanupRoot = realMkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-test-"));
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      const dir = (realMkdtemp as (p: string) => string)(
        path.join(cleanupRoot, path.basename(prefix)),
      );
      created.push(dir);
      return dir;
    }) as unknown as typeof fs.mkdtempSync);
    run.mockImplementation(() => {
      throw new Error("spawn failed before any result");
    });
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });

    try {
      const error = applyWeatherPreset();

      expect(created).toHaveLength(1);
      expect((error as Error).message).toMatch(/still holds the composed sandbox policy/iu);
    } finally {
      vi.restoreAllMocks();
      removeTemporaryDirectory(cleanupRoot, realRmSync);
    }
  });
});
