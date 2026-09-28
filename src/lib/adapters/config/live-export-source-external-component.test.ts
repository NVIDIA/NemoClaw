// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  exportLiveSource,
  mockSupportedLiveSource,
} from "../../../../test/support/config-export-harness";
import { observeExternalComponentGatewayConfiguration } from "../../onboard/docker-driver-gateway-config";
import { loadExternalComponentDeclaration } from "../../onboard/external-component";
import { entry } from "./live-export-source-test-fixture";

const declaration = {
  schemaVersion: 1 as const,
  componentId: "policy-governance",
  interceptorSocketPath: "/run/user/1000/policy-governance/interceptor.sock",
  activationSocketPath: "/run/user/1000/policy-governance/activation.sock",
};
const selection = {
  schemaVersion: 1 as const,
  componentId: declaration.componentId,
  gatewayName: "nemoclaw",
  lifecycleGeneration: entry.lifecycleGeneration,
  sandboxIdentityFingerprint: entry.lifecycleLiveIdentityFingerprint,
};

afterEach(() => {
  vi.mocked(observeExternalComponentGatewayConfiguration).mockReturnValue(null);
  vi.mocked(loadExternalComponentDeclaration).mockReturnValue(null);
});

describe("live external component export (#11453)", () => {
  it("exports the reference when activation, registration, and gateway agree", async () => {
    mockSupportedLiveSource(3, 3, { ...entry, externalComponentSelection: selection });
    vi.mocked(observeExternalComponentGatewayConfiguration).mockReturnValue({
      componentId: declaration.componentId,
      interceptorSocketPath: declaration.interceptorSocketPath,
    });
    vi.mocked(loadExternalComponentDeclaration).mockReturnValue({
      declaration,
      revalidateBeforeGateway: vi.fn(),
      revalidateBeforeActivation: vi.fn(),
    });
    const exported = await exportLiveSource();
    expect(exported.result).toMatchObject({ ok: true });
    expect(YAML.parse(exported.writeStdout.mock.calls[0]![0])).toMatchObject({
      spec: { gateway: { externalComponentRef: declaration.componentId } },
    });
  });

  it("refuses an unregistered gateway component", async () => {
    mockSupportedLiveSource(3, 3, { ...entry, externalComponentSelection: selection });
    vi.mocked(observeExternalComponentGatewayConfiguration).mockReturnValue({
      componentId: declaration.componentId,
      interceptorSocketPath: declaration.interceptorSocketPath,
    });
    const exported = await exportLiveSource();
    expect(exported.result).toMatchObject({ ok: false });
    expect(exported.writeStdout).not.toHaveBeenCalled();
  });

  it("refuses a component socket that changes between observations", async () => {
    mockSupportedLiveSource(3, 3, { ...entry, externalComponentSelection: selection });
    let socket = "/run/user/1000/policy-governance/first.sock";
    vi.mocked(observeExternalComponentGatewayConfiguration).mockImplementation(() => {
      socket = socket.endsWith("first.sock")
        ? "/run/user/1000/policy-governance/second.sock"
        : "/run/user/1000/policy-governance/first.sock";
      return { componentId: declaration.componentId, interceptorSocketPath: socket };
    });
    vi.mocked(loadExternalComponentDeclaration).mockImplementation(() => ({
      declaration: { ...declaration, interceptorSocketPath: socket },
      revalidateBeforeGateway: vi.fn(),
      revalidateBeforeActivation: vi.fn(),
    }));
    const exported = await exportLiveSource();
    expect(exported.result).toMatchObject({
      ok: false,
      failure: { findings: [expect.objectContaining({ category: "unstable-source" })] },
    });
    expect(exported.writeStdout).not.toHaveBeenCalled();
  });
});
