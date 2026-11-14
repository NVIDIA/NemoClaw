// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, it, expect, vi } from "vitest";
import type * as registry from "../../state/registry";
import * as sandboxConfig from "../../sandbox/config";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import { restoreExternalHermesInference } from "./rebuild-hermes-post-restore";
vi.mock("../../sandbox/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sandbox/config")>();
  return {
    ...actual,
    resolveAgentConfig: vi.fn(actual.resolveAgentConfig),
    readSandboxConfig: vi.fn(actual.readSandboxConfig),
    writeSandboxConfig: vi.fn(actual.writeSandboxConfig),
  };
});

beforeEach(() => {
  vi.mocked(sandboxConfig.resolveAgentConfig).mockReset();
  vi.mocked(sandboxConfig.readSandboxConfig).mockReset();
  vi.mocked(sandboxConfig.writeSandboxConfig).mockReset();
});
function restoredExternalHermes() {
  const entry = {
    name: "alpha",
    agent: "hermes",
    gatewayName: "nemoclaw-19080",
    lifecycleGeneration: "replacement-generation",
    lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("replacement-id"),
    provider: "compatible-endpoint",
    model: "selected-model",
    endpointUrl: "https://models.example.test/v1",
    workload: { kind: "external-image" },
    nativeHostedProviderAttachment: { profileId: "native-custom" },
  } as registry.SandboxEntry;
  const read = vi.fn(() => entry);
  const capture = vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
    status: 0,
    output: "Id: replacement-id\n",
  });
  const config = {
    model: { api_key: "[STRIPPED_BY_MIGRATION]" },
    user_setting: "preserved",
  };
  vi.mocked(sandboxConfig.resolveAgentConfig).mockReturnValue({ agentName: "hermes" } as never);
  vi.mocked(sandboxConfig.readSandboxConfig).mockReturnValue(config);
  const write = vi.mocked(sandboxConfig.writeSandboxConfig).mockImplementation(() => undefined);
  const run = () =>
    restoreExternalHermesInference(
      entry,
      { gatewayName: "nemoclaw-19080", workspace: "default" },
      read,
    );
  return { entry, config, capture, write, run };
}

it("reapplies registered Hermes inference after archive sanitation (#12603)", async () => {
  const f = restoredExternalHermes();
  await f.run();
  expect(f.config).toMatchObject({
    model: {
      default: "selected-model",
      api_key: "${COMPATIBLE_API_KEY}",
      base_url: "https://models.example.test/v1",
    },
    user_setting: "preserved",
  });
  expect(f.write).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({ agentName: "hermes" }),
    f.config,
    "nemoclaw-19080",
  );
  expect(f.capture).toHaveBeenCalledWith(
    ["sandbox", "get", "-g", "nemoclaw-19080", "alpha"],
    expect.objectContaining({
      env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw-19080" }),
    }),
  );
});

it("rejects a replaced Hermes sandbox before writing restored inference (#12603)", async () => {
  const f = restoredExternalHermes();
  f.capture
    .mockReturnValueOnce({ status: 0, output: "Id: replacement-id\n" })
    .mockReturnValue({ status: 0, output: "Id: unrelated-id\n" });
  await expect(f.run()).rejects.toThrow("live identity");
  expect(f.write).not.toHaveBeenCalled();
});

it("rejects a changed Hermes inference selection before configuration write (#12603)", async () => {
  const f = restoredExternalHermes();
  f.capture
    .mockImplementationOnce(() => ({ status: 0, output: "Id: replacement-id\n" }))
    .mockImplementation(() => {
      f.entry.model = "unrelated-model";
      return { status: 0, output: "Id: replacement-id\n" };
    });
  await expect(f.run()).rejects.toThrow("inference selection changed");
  expect(f.write).not.toHaveBeenCalled();
});
