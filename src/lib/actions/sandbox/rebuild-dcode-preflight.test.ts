// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  configureDcodeSession,
  expectNoDcodeMutation,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-helpers";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-dcode-harness";
import * as gatewayRuntime from "../../gateway-runtime-action";
import { ensureDcodeRebuildTargetGatewaySelected } from "./rebuild-dcode-preflight";
import { resolveRebuildDurableConfig } from "./rebuild-durable-config";

describe("rebuildSandbox DCode flow: preflight", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("keeps non-MCP ambient selectors while pinning the recorded gateway (#10514)", async () => {
    const restoreEnv = snapshotEnv([
      "OPENSHELL_GATEWAY",
      "OPENSHELL_GATEWAY_ENDPOINT",
      "OPENSHELL_LOCAL_TLS_DIR",
      "OPENSHELL_TOKEN",
      "OPENSHELL_WORKSPACE",
    ]);
    process.env.OPENSHELL_GATEWAY = "hostile-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://hostile.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/hostile/tls";
    process.env.OPENSHELL_TOKEN = "hostile-token";
    process.env.OPENSHELL_WORKSPACE = "hostile-workspace";
    const gatewayState = {
      state: "healthy_named" as const,
      activeGateway: "nemoclaw",
      status: "",
      gatewayInfo: "",
    };
    const recover = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      attempted: false,
      before: gatewayState,
      after: gatewayState,
    });
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    try {
      await expect(
        ensureDcodeRebuildTargetGatewaySelected(
          "alpha",
          makeDcodeSandboxEntry() as never,
          vi.fn(),
          bail,
        ),
      ).resolves.toBe(true);

      expect(recover).toHaveBeenCalledWith({
        gatewayName: "nemoclaw",
        recoverableStates: [
          "missing_named",
          "named_unhealthy",
          "named_unreachable",
          "connected_other",
        ],
      });
      expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw");
      expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("https://hostile.invalid");
      expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBe("/hostile/tls");
      expect(process.env.OPENSHELL_TOKEN).toBe("hostile-token");
      expect(process.env.OPENSHELL_WORKSPACE).toBe("hostile-workspace");
    } finally {
      restoreEnv();
    }
  });

  it.each([
    ["defaults legacy state to disabled", undefined, undefined, "disabled", null],
    ["uses recorded state", "thread-opt-in", undefined, "thread-opt-in", null],
    ["applies an explicit override", "disabled", "thread-opt-in", "thread-opt-in", null],
    [
      "does not let an explicit override mask corrupt state",
      "always",
      "thread-opt-in",
      "thread-opt-in",
      "recorded dcodeAutoApprovalMode value must be disabled or thread-opt-in",
    ],
  ] as const)(
    "resolves durable DCode mode: %s (#6478)",
    (_label, recorded, requested, expected, error) => {
      const config = resolveRebuildDurableConfig(
        "alpha",
        {
          name: "alpha",
          agent: "langchain-deepagents-code",
          nemoclawVersion: "0.1.0",
          ...(recorded !== undefined ? { dcodeAutoApprovalMode: recorded as never } : {}),
        },
        null,
        undefined,
        undefined,
        false,
        requested,
      );

      expect(config.dcodeAutoApprovalMode).toBe(expected);
      expect(config.dcodeAutoApprovalModeError).toBe(error);
    },
  );

  it("rejects a DCode auto-approval override for unsupported agents before mutation (#6478)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "openclaw",
      sandboxEntry: { name: "alpha", agent: "openclaw", nemoclawVersion: "0.1.0" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", "--dcode-auto-approval", "thread-opt-in"], {
        throwOnError: true,
      }),
    ).rejects.toThrow("Unsupported rebuild DCode auto-approval override");

    expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });

  it("rejects recorded DCode auto-approval on an unsupported agent before mutation (#6478)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "openclaw",
      sandboxEntry: {
        name: "alpha",
        agent: "openclaw",
        dcodeAutoApprovalMode: "thread-opt-in",
        nemoclawVersion: "0.1.0",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("incompatible with the sandbox agent");

    expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });

  it("allows an explicit disabled rebuild to repair unsupported recorded state (#6478)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "openclaw",
      sandboxEntry: {
        name: "alpha",
        agent: "openclaw",
        dcodeAutoApprovalMode: "thread-opt-in",
        nemoclawVersion: "0.1.0",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", "--dcode-auto-approval", "disabled"], {
        throwOnError: true,
      }),
    ).resolves.toBeUndefined();

    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dcodeAutoApprovalMode: "disabled",
        dcodeAutoApprovalRequestedExplicitly: true,
      }),
    );
  });

  it("rejects an invalid durable DCode auto-approval mode before mutation (#6478)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        dcodeAutoApprovalMode: "always",
      },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded DCode auto-approval state is invalid");

    expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });

  it("rejects a stored DCode route failure before any rebuild mutation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [
        { ok: false, detail: "existing sandbox inference probe returned HTTP 401" },
      ],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded inference route smoke check failed");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledOnce();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });
  it("keeps DCode intact when its recorded gateway cannot become healthy (#6195)", async () => {
    const restoreEnv = snapshotEnv(["OPENSHELL_GATEWAY"]);
    process.env.OPENSHELL_GATEWAY = "previous-gateway";

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
        gatewayRecoveryResult: {
          recovered: false,
          attempted: true,
          before: { state: "named_unhealthy" },
          after: { state: "named_unhealthy" },
        },
      });
      configureDcodeSession(harness);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Could not select healthy gateway 'nemoclaw'");

      expect(process.env.OPENSHELL_GATEWAY).toBe("previous-gateway");
      expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
      expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
      expectNoDcodeMutation(harness);
    } finally {
      restoreEnv();
    }
  });
  it("restores the complete OpenShell environment when preflight fails after target pin (#6195)", async () => {
    const restoreEnv = snapshotEnv([
      "OPENSHELL_GATEWAY",
      "OPENSHELL_GATEWAY_ENDPOINT",
      "OPENSHELL_LOCAL_TLS_DIR",
      "OPENSHELL_TOKEN",
      "OPENSHELL_UNRELATED",
      "OPENSHELL_WORKSPACE",
    ]);
    process.env.OPENSHELL_GATEWAY = "previous-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://previous.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/previous/tls";
    process.env.OPENSHELL_TOKEN = "previous-token";
    process.env.OPENSHELL_UNRELATED = "previous-value";
    process.env.OPENSHELL_WORKSPACE = "previous-workspace";
    const mcpEntry = { server: "search", providerName: "mcp-search" };
    const runtimeSelection = { gatewayName: "nemoclaw", workspace: "default" };

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: {
          ...makeDcodeSandboxEntry(),
          mcp: { bridges: { search: mcpEntry } },
        },
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [],
          scrubbedAdapterEntries: [],
          runtimeSelection,
        },
        preflightMessagingConflicts: () => {
          throw new Error("messaging conflict preflight failed");
        },
      });
      configureDcodeSession(harness);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("messaging conflict preflight failed");

      expect(harness.preflightMessagingConflictsSpy).toHaveBeenCalledOnce();
      expect(process.env.OPENSHELL_GATEWAY).toBe("previous-gateway");
      expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("https://previous.invalid");
      expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBe("/previous/tls");
      expect(process.env.OPENSHELL_TOKEN).toBe("previous-token");
      expect(process.env.OPENSHELL_UNRELATED).toBe("previous-value");
      expect(process.env.OPENSHELL_WORKSPACE).toBe("previous-workspace");
      expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
      expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
      expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
      expectNoDcodeMutation(harness);
    } finally {
      restoreEnv();
    }
  });
  it("rejects a DCode replacement-image failure before any rebuild mutation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeImageResult: { ok: false, detail: "replacement image build failed" },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow();

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledOnce();
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });
  it("rejects a managed DCode session with a recorded custom Dockerfile before image preparation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    harness.session.metadata = { fromDockerfile: "/tmp/custom/Dockerfile" };

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Managed DCode rebuild cannot use a recorded custom Dockerfile");

    expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });
  it("rejects a registry-owned DCode custom Dockerfile before image preparation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        fromDockerfile: "/tmp/registry-owned-custom.Dockerfile",
      },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Managed DCode rebuild cannot use a recorded custom Dockerfile");

    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });
  it("lets explicit registry-managed DCode state override stale session Dockerfile metadata (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: { ...makeDcodeSandboxEntry(), fromDockerfile: null },
    });
    configureDcodeSession(harness);
    harness.session.metadata = { fromDockerfile: "/tmp/stale-session.Dockerfile" };

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fromDockerfile: null }),
    );
  });
});
