// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as projection from "../../onboard/hermes/initial-inference-route";
import * as registry from "../../state/registry";
import * as capture from "../../adapters/openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import { refreshRestoredHermesInferenceRoute } from "./rebuild-hermes-post-restore";

const runtime = {
  gatewayName: "selected-gateway",
  workspace: "selected-workspace",
  localTlsDir: "/selected/tls",
};
const commandEnvironment = {
  OPENSHELL_GATEWAY: runtime.gatewayName,
  OPENSHELL_WORKSPACE: runtime.workspace,
  OPENSHELL_LOCAL_TLS_DIR: runtime.localTlsDir,
  ABSENT: undefined,
};
function fixture() {
  const entry = {
    name: "alpha",
    agent: "hermes",
    gatewayName: runtime.gatewayName,
    model: "selected-model",
    provider: "compatible-endpoint",
    lifecycleGeneration: "replacement-generation",
    lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("replacement-id"),
  } as registry.SandboxEntry;
  vi.spyOn(registry, "getSandbox").mockImplementation(() => entry);
  const observe = vi.spyOn(capture, "captureSanitizedResolvedOpenshell").mockReturnValue({
    status: 0,
    output: "Id: replacement-id",
    stdout: "Id: replacement-id",
    stderr: "",
  });
  const write = vi.fn();
  const project = vi.fn<projection.InitializeHermesInferenceRoute>(
    async (_name, _model, _provider, _gateway, revalidate) => {
      revalidate?.("write restored config");
      write();
    },
  );
  const factory = vi
    .spyOn(projection, "createInitialHermesInferenceRoute")
    .mockReturnValue(project);
  return { entry, observe, write, project, factory };
}

afterEach(() => vi.restoreAllMocks());

describe("restored Hermes route identity", () => {
  it("pins the replacement live identity and selected runtime before deferred projection", async () => {
    const f = fixture();
    await refreshRestoredHermesInferenceRoute(
      "alpha",
      runtime,
      registry.getSandbox,
      commandEnvironment,
    );
    expect(f.factory).toHaveBeenCalledWith(
      expect.objectContaining({ getSandbox: expect.any(Function) }),
      { activation: "deferred", workload: "registered", projection: "credential" },
    );
    expect(f.project).toHaveBeenCalledWith(
      "alpha",
      "selected-model",
      "compatible-endpoint",
      runtime.gatewayName,
      expect.any(Function),
    );
    expect(f.observe).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", runtime.gatewayName, "alpha"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: runtime.gatewayName,
          OPENSHELL_WORKSPACE: runtime.workspace,
          OPENSHELL_LOCAL_TLS_DIR: runtime.localTlsDir,
        }),
        replaceEnv: true,
        timeout: 30000,
      }),
    );
    expect(f.observe.mock.calls[0][1]?.env).not.toHaveProperty("ABSENT");
    expect(f.write).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "same-name replacement",
      arrange: (f: ReturnType<typeof fixture>) =>
        f.observe.mockReturnValue({
          status: 0,
          output: "Id: foreign-id",
          stdout: "Id: foreign-id",
        }),
    },
    {
      name: "unobservable target",
      arrange: (f: ReturnType<typeof fixture>) =>
        f.observe.mockReturnValue({
          status: 1,
          output: "unavailable",
          stdout: "",
        }),
    },
    {
      name: "registered generation drift",
      arrange: (f: ReturnType<typeof fixture>) =>
        f.project.mockImplementation(async (_n, _m, _p, _g, revalidate) => {
          f.entry.lifecycleGeneration = "foreign-generation";
          revalidate?.("write restored config");
          f.write();
        }),
    },
  ])("refuses $name without a write", async ({ arrange }) => {
    const f = fixture();
    arrange(f);
    await expect(
      refreshRestoredHermesInferenceRoute(
        "alpha",
        runtime,
        registry.getSandbox,
        commandEnvironment,
      ),
    ).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });
});
