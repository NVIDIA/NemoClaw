// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
  expectExportRefusal,
} from "../../../../test/support/config-export-harness";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { connectExternalHttpOpenShellSdk, connectManagedOpenShellSdk } from "../openshell/sdk";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { observeExportGateway } from "./gateway-export";
import { readFailureCanary } from "./live-export-source-test-fixture";
import type { ExportSnapshotReadStage } from "../../domain/config/export-evidence";

vi.mock("./gateway-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-export")>()),
  observeExportGateway: vi.fn(),
}));

const external = {
  name: "nemoclaw",
  port: 8080,
  management: "external",
  stateRootOwned: false,
  external: {
    endpoint: "http://127.0.0.1:8080",
    authorityFingerprint: "a".repeat(64),
    listenerPid: 4242,
    listenerStartTime: "710024",
  },
} as const;

function mockExternalSource() {
  mockSupportedLiveSource();
  vi.mocked(observeExportGateway).mockResolvedValue(external);
  vi.mocked(connectExternalHttpOpenShellSdk).mockResolvedValue({ raw });
}

beforeEach(() => {
  vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "");
});

describe("external gateway live source reader", () => {
  it("uses one verified endpoint for SDK and inference reads without managed fallback (#11861)", async () => {
    mockExternalSource();
    vi.stubEnv("OPENSHELL_GATEWAY_TOKEN", "ambient-token-canary");
    const exported = await exportLiveSource();
    expect(exported.result.ok).toBe(true);
    const yaml = exported.writeStdout.mock.calls[0]![0];
    expect(asExportedConfig(YAML.parse(yaml)).spec.gateway).toEqual({
      management: "external",
      endpoint: external.external.endpoint,
    });
    expect(connectExternalHttpOpenShellSdk).toHaveBeenCalledTimes(6);
    expect(connectExternalHttpOpenShellSdk).toHaveBeenCalledWith(
      { kind: "named", gatewayName: "nemoclaw" },
      external.external.endpoint,
      { signal: expect.any(AbortSignal) },
    );
    expect(connectManagedOpenShellSdk).not.toHaveBeenCalled();
    expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledWith(
      expect.arrayContaining(["inference", "get", "-g", "nemoclaw"]),
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY_ENDPOINT: external.external.endpoint,
          OPENSHELL_WORKSPACE: "default",
        }),
      }),
    );
    expect(vi.mocked(captureSanitizedResolvedOpenshell).mock.calls[0]![1].env).not.toHaveProperty(
      "OPENSHELL_GATEWAY_TOKEN",
    );
    expect(yaml).not.toContain(readFailureCanary);
    expect(yaml).not.toContain("ambient-token-canary");
    expect(observeExportGateway).toHaveBeenCalledTimes(4);
    const routeEnvironment = vi.mocked(captureSanitizedResolvedOpenshell).mock.calls[0]![1].env;
    expect(fs.existsSync(routeEnvironment?.HOME ?? "")).toBe(false);
  });

  it("isolates and removes CLI credential locations when the route read fails (#11861)", async () => {
    mockExternalSource();
    const parentHome = process.env.HOME;
    vi.stubEnv("OPENSHELL_SYSTEM_GATEWAY_DIR", "/source-system-credentials");
    let temporaryHome = "";
    let capturedEnvironment: Record<string, string> = {};
    let contents: string[] | undefined;
    vi.mocked(captureSanitizedResolvedOpenshell).mockImplementationOnce((_args, options) => {
      capturedEnvironment = { ...options.env };
      temporaryHome = capturedEnvironment.HOME ?? "";
      contents = fs.readdirSync(temporaryHome);
      throw new Error(readFailureCanary);
    });
    const exported = await exportLiveSource();
    expectExportRefusal(exported, { category: "live-verification-failed" });
    expect(temporaryHome).not.toBe("");
    expect(temporaryHome).not.toBe(parentHome);
    expect(contents).toEqual([]);
    expect(capturedEnvironment).toMatchObject({
      XDG_CONFIG_HOME: path.join(temporaryHome, "config"),
      XDG_CACHE_HOME: path.join(temporaryHome, "cache"),
      XDG_DATA_HOME: path.join(temporaryHome, "data"),
      XDG_STATE_HOME: path.join(temporaryHome, "state"),
      OPENSHELL_SYSTEM_GATEWAY_DIR: path.join(temporaryHome, "system"),
      OPENSHELL_GATEWAY_ENDPOINT: external.external.endpoint,
    });
    expect(fs.existsSync(temporaryHome)).toBe(false);
    expect(process.env.HOME).toBe(parentHome);
    expect(process.env.OPENSHELL_SYSTEM_GATEWAY_DIR).toBe("/source-system-credentials");
    expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
  });

  it("refuses a listener replaced during the source read before publication (#11861)", async () => {
    mockExternalSource();
    vi.mocked(observeExportGateway)
      .mockResolvedValueOnce(external)
      .mockResolvedValueOnce({
        ...external,
        external: { ...external.external, listenerStartTime: "999999" },
      });
    const exported = await exportLiveSource();
    expectExportRefusal(exported, { category: "live-verification-failed" });
    expect(exported.result).toMatchObject({
      failure: {
        findings: [
          {
            diagnostic:
              "External gateway evidence changed during export. Retry after the gateway configuration and listener are stable.",
          },
        ],
      },
    });
    expect(connectManagedOpenShellSdk).not.toHaveBeenCalled();
  });

  it.each([
    {
      stage: "gateway-authority",
      diagnostic:
        "The gateway declaration or retained onboarding authority could not be verified. Check the declaration against the gateway selected during onboarding.",
    },
    {
      stage: "gateway-configuration",
      diagnostic:
        "External gateway export requires native Linux and an HTTP 127.0.0.1 origin without gateway credentials. Check the declared endpoint and host platform.",
    },
    {
      stage: "gateway-registration",
      diagnostic:
        "The external gateway registration could not be verified. Check that its endpoint and authentication match the gateway declaration.",
    },
    {
      stage: "gateway-listener",
      diagnostic:
        "The external gateway listener or supervisor identity could not be verified. Check that the declared service owns the running gateway listener.",
    },
  ] satisfies { stage: ExportSnapshotReadStage; diagnostic: string }[])(
    "reports safe recovery guidance for $stage without connecting or publishing (#11861)",
    async ({ stage, diagnostic }) => {
      mockExternalSource();
      vi.mocked(observeExportGateway).mockImplementationOnce(async (_entry, beforeRead) => {
        beforeRead?.(stage);
        throw new Error(`${readFailureCanary} /private/gateway-state \u001b[2J`);
      });

      const exported = await exportLiveSource();

      expectExportRefusal(exported, { category: "live-verification-failed" });
      expect(exported.result).toMatchObject({ failure: { findings: [{ diagnostic }] } });
      expect(connectExternalHttpOpenShellSdk).not.toHaveBeenCalled();
      expect(connectManagedOpenShellSdk).not.toHaveBeenCalled();
      expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
      expect(JSON.stringify(exported.result)).not.toContain("/private/gateway-state");
      expect(JSON.stringify(exported.result)).not.toContain("\\u001b");
    },
  );

  it("keeps registration recovery guidance when the final gateway check fails (#11861)", async () => {
    mockExternalSource();
    vi.mocked(observeExportGateway)
      .mockResolvedValueOnce(external)
      .mockImplementationOnce(async (_entry, beforeRead) => {
        beforeRead?.("gateway-registration");
        throw new Error(readFailureCanary);
      });

    const exported = await exportLiveSource();

    expectExportRefusal(exported, { category: "live-verification-failed" });
    expect(exported.result).toMatchObject({
      failure: {
        findings: [
          {
            diagnostic:
              "The external gateway registration could not be verified. Check that its endpoint and authentication match the gateway declaration.",
          },
        ],
      },
    });
    expect(connectExternalHttpOpenShellSdk).toHaveBeenCalled();
    expect(connectManagedOpenShellSdk).not.toHaveBeenCalled();
    expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
  });

  it("does not fall back to a managed connection when the external SDK fails (#11861)", async () => {
    mockExternalSource();
    vi.mocked(connectExternalHttpOpenShellSdk).mockRejectedValue(new Error(readFailureCanary));
    const exported = await exportLiveSource();
    expectExportRefusal(exported, { category: "live-verification-failed" });
    expect(connectManagedOpenShellSdk).not.toHaveBeenCalled();
    expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
  });

  it("refuses export when the external SDK connection remains pending at the deadline (#11861)", async () => {
    mockExternalSource();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.mocked(connectExternalHttpOpenShellSdk).mockImplementationOnce(() => {
      controller.abort();
      return new Promise(() => {});
    });

    const exported = await exportLiveSource();

    expectExportRefusal(exported, { category: "live-verification-failed" });
    expect(connectExternalHttpOpenShellSdk).toHaveBeenCalledTimes(1);
    expect(raw.getSandbox).not.toHaveBeenCalled();
    expect(connectManagedOpenShellSdk).not.toHaveBeenCalled();
  });

  it("does not connect when gateway provenance cannot be verified (#11861)", async () => {
    mockExternalSource();
    vi.mocked(observeExportGateway).mockRejectedValue(new Error(readFailureCanary));
    const exported = await exportLiveSource();
    expectExportRefusal(exported, { category: "live-verification-failed" });
    expect(exported.result).toMatchObject({
      failure: {
        findings: [{ diagnostic: "The registered gateway binding could not be read or verified." }],
      },
    });
    expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
    expect(connectExternalHttpOpenShellSdk).not.toHaveBeenCalled();
    expect(connectManagedOpenShellSdk).not.toHaveBeenCalled();
  });
});
