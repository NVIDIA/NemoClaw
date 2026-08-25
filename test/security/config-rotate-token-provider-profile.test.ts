// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as never;
function restoreCachedModule(modulePath: string, previous: unknown): void {
  Reflect.deleteProperty(requireCache, modulePath);
  Object.assign(requireCache, previous === undefined ? {} : { [modulePath]: previous });
}

function loadRotateTokenFixture(input: {
  providerType: string;
  captureResults: Array<Record<string, unknown>>;
}) {
  const previousHome = process.env.HOME;
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-rotate-profile-"));
  process.env.HOME = testHome;
  const sandboxConfigPath = require.resolve("../../src/lib/sandbox/config");
  const openshellPath = require.resolve("../../src/lib/adapters/openshell/client");
  const shieldsAuditPath = require.resolve("../../src/lib/shields/audit");
  const sessionPath = require.resolve("../../src/lib/state/onboard-session");
  const credentialStorePath = require.resolve("../../src/lib/credentials/store");
  const previousModules = {
    sandboxConfig: require.cache[sandboxConfigPath],
    openshell: require.cache[openshellPath],
    shieldsAudit: require.cache[shieldsAuditPath],
    session: require.cache[sessionPath],
    credentialStore: require.cache[credentialStorePath],
  };
  const queuedCaptureResults = [...input.captureResults];
  const captureOpenshellCommand = vi.fn((_binary: string, _args: string[], _options?: unknown) =>
    queuedCaptureResults.shift(),
  );
  const runOpenshellCommand = vi.fn(() => ({ status: 0 }));
  const appendAuditEntry = vi.fn();
  const saveCredential = vi.fn();

  Reflect.deleteProperty(requireCache, sandboxConfigPath);
  requireCache[openshellPath] = {
    id: openshellPath,
    filename: openshellPath,
    loaded: true,
    exports: { captureOpenshellCommand, runOpenshellCommand },
  } as never;
  requireCache[shieldsAuditPath] = {
    id: shieldsAuditPath,
    filename: shieldsAuditPath,
    loaded: true,
    exports: { appendAuditEntry },
  } as never;
  requireCache[sessionPath] = {
    id: sessionPath,
    filename: sessionPath,
    loaded: true,
    exports: {
      loadSession: () => ({
        sandboxName: "rotate-profile-test",
        credentialEnv: "OPENAI_API_KEY",
        provider: "inference",
        providerType: input.providerType,
      }),
    },
  } as never;
  requireCache[credentialStorePath] = {
    id: credentialStorePath,
    filename: credentialStorePath,
    loaded: true,
    exports: { saveCredential, promptSecret: vi.fn() },
  } as never;

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const previousToken = process.env.ROTATE_PROFILE_TOKEN;
  process.env.ROTATE_PROFILE_TOKEN = "rotation-secret";
  const { configRotateToken } = require("../../src/lib/sandbox/config");

  return {
    appendAuditEntry,
    captureOpenshellCommand,
    configRotateToken,
    runOpenshellCommand,
    saveCredential,
    restore: () => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      Reflect.deleteProperty(process.env, "ROTATE_PROFILE_TOKEN");
      Object.assign(
        process.env,
        previousToken === undefined ? {} : { ROTATE_PROFILE_TOKEN: previousToken },
      );
      Reflect.deleteProperty(process.env, "HOME");
      Object.assign(process.env, previousHome === undefined ? {} : { HOME: previousHome });
      restoreCachedModule(sandboxConfigPath, previousModules.sandboxConfig);
      restoreCachedModule(openshellPath, previousModules.openshell);
      restoreCachedModule(shieldsAuditPath, previousModules.shieldsAudit);
      restoreCachedModule(sessionPath, previousModules.session);
      restoreCachedModule(credentialStorePath, previousModules.credentialStore);
      fs.rmSync(testHome, { recursive: true, force: true });
    },
  };
}

describe("config rotate-token OpenAI provider profile", () => {
  it("imports a missing OpenAI profile before rotating the provider token (#10155)", async () => {
    const fixture = loadRotateTokenFixture({
      providerType: "openai",
      captureResults: [
        { status: 1, stdout: "", stderr: "provider profile not found" },
        { status: 0, stdout: "Imported", stderr: "" },
      ],
    });
    try {
      await fixture.configRotateToken("rotate-profile-test", {
        fromEnv: "ROTATE_PROFILE_TOKEN",
      });

      expect(fixture.captureOpenshellCommand.mock.calls.map(([, args]) => args)).toEqual([
        ["provider", "profile", "export", "openai", "--output", "json"],
        ["provider", "profile", "import", "--file", expect.stringMatching(/openai\.yaml$/u)],
      ]);
      expect(fixture.captureOpenshellCommand.mock.calls[0]?.[2]).toMatchObject({
        ignoreError: true,
        includeStreams: true,
        timeout: 30_000,
      });
      expect(fixture.captureOpenshellCommand.mock.invocationCallOrder[1]).toBeLessThan(
        fixture.saveCredential.mock.invocationCallOrder[0]!,
      );
      expect(fixture.saveCredential.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.runOpenshellCommand.mock.invocationCallOrder[0]!,
      );
    } finally {
      fixture.restore();
    }
  });

  it("rejects an incompatible OpenAI profile before staging or rotating the token (#10155)", async () => {
    const fixture = loadRotateTokenFixture({
      providerType: "openai",
      captureResults: [
        {
          status: 0,
          stdout: JSON.stringify({
            id: "openai",
            credentials: [{ env: "OPENAI_API_KEY" }],
            endpoints: [],
            binaries: [],
            inference_capable: true,
          }),
          stderr: "",
        },
      ],
    });
    try {
      await expect(
        fixture.configRotateToken("rotate-profile-test", {
          fromEnv: "ROTATE_PROFILE_TOKEN",
        }),
      ).rejects.toThrow("does not match NemoClaw's endpointless inference contract");
      expect(fixture.saveCredential).not.toHaveBeenCalled();
      expect(fixture.runOpenshellCommand).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it("suppresses failed profile import output before rotating the token (#10155)", async () => {
    const profileSecret = "profile-import-secret";
    const fixture = loadRotateTokenFixture({
      providerType: "openai",
      captureResults: [
        { status: 1, stdout: "", stderr: "provider profile not found" },
        { status: 1, stdout: "", stderr: `import rejected: ${profileSecret}` },
      ],
    });
    try {
      let thrown = "";
      try {
        await fixture.configRotateToken("rotate-profile-test", {
          fromEnv: "ROTATE_PROFILE_TOKEN",
        });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }

      expect(thrown).toContain("could not import the checked-in 'openai'");
      expect(thrown).not.toContain(profileSecret);
      expect(thrown).not.toContain("rotation-secret");
      expect(fixture.saveCredential).not.toHaveBeenCalled();
      expect(fixture.runOpenshellCommand).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it("does not inspect the OpenAI profile for another provider type (#10155)", async () => {
    const fixture = loadRotateTokenFixture({ providerType: "nvidia", captureResults: [] });
    try {
      await fixture.configRotateToken("rotate-profile-test", {
        fromEnv: "ROTATE_PROFILE_TOKEN",
      });

      expect(fixture.captureOpenshellCommand).not.toHaveBeenCalled();
      expect(fixture.saveCredential).toHaveBeenCalledWith("OPENAI_API_KEY", "rotation-secret");
      expect(fixture.runOpenshellCommand).toHaveBeenCalledOnce();
      expect(fixture.appendAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: "rotate_token" }),
      );
    } finally {
      fixture.restore();
    }
  });
});
