// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfigTarget } from "../sandbox/config";
import { setOpenClawConfigValue } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
// Import source directly so tests cannot pass against a stale build.
import {
  computeTunnelAllowedOrigins,
  isTryCloudflareOrigin,
  type RegisterTunnelOriginDeps,
  registerTunnelOrigin,
  tunnelUrlToOrigin,
} from "./allowed-origins";

vi.mock("../sandbox/config", () => ({ setOpenClawConfigValue: vi.fn() }));

const recovery =
  require("../actions/sandbox/process-recovery") as typeof import("../actions/sandbox/process-recovery");

const LOOPBACK = "http://127.0.0.1:18789";
const RUNTIME = { gatewayName: "recorded", workspace: "default" };

const OPENCLAW_TARGET: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
};

beforeEach(() => {
  vi.mocked(setOpenClawConfigValue).mockClear();
});

/**
 * Build a fully-injected dep set backed by spies so no test here touches
 * openshell/docker.
 */
function makeDeps(config: ConfigObject, target: AgentConfigTarget = OPENCLAW_TARGET) {
  const resolveAgentConfig = vi.fn((_sb: string): AgentConfigTarget => target);
  const readConfig = vi.fn((_sb: string, _t: AgentConfigTarget): ConfigObject => config);
  const writeAllowedOrigins = vi.fn(async (_sb: string, _origins: string[]): Promise<void> => {});
  const reloadGateway = vi.fn(async (_sb: string): Promise<void> => {});
  const info = vi.fn((_msg: string): void => {});
  const warn = vi.fn((_msg: string): void => {});
  const deps: RegisterTunnelOriginDeps = {
    resolveRuntimeSelection: () => RUNTIME,
    resolveAgentConfig,
    readConfig,
    writeAllowedOrigins,
    reloadGateway,
    info,
    warn,
  };
  return {
    deps,
    resolveAgentConfig,
    readConfig,
    writeAllowedOrigins,
    reloadGateway,
    info,
    warn,
  };
}

// Scenario 1
describe("tunnelUrlToOrigin", () => {
  it("reduces a quick-tunnel URL with a path and hash to a bare origin", () => {
    expect(tunnelUrlToOrigin("https://good.trycloudflare.com/route#x")).toBe(
      "https://good.trycloudflare.com",
    );
  });

  it("returns a named-tunnel URL's origin unchanged", () => {
    expect(tunnelUrlToOrigin("https://agent.example.com")).toBe("https://agent.example.com");
  });

  it("returns null for empty input", () => {
    expect(tunnelUrlToOrigin("")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(tunnelUrlToOrigin("not-a-url")).toBeNull();
  });
});

// Scenario 2
describe("isTryCloudflareOrigin", () => {
  it("is true for a trycloudflare subdomain", () => {
    expect(isTryCloudflareOrigin("https://x.trycloudflare.com")).toBe(true);
  });

  it("is true for the apex trycloudflare host", () => {
    expect(isTryCloudflareOrigin("https://trycloudflare.com")).toBe(true);
  });

  it("is false for a look-alike host that only embeds trycloudflare.com", () => {
    expect(isTryCloudflareOrigin("https://x.trycloudflare.com.evil.test")).toBe(false);
  });

  it("is false for an unrelated host", () => {
    expect(isTryCloudflareOrigin("https://agent.example.com")).toBe(false);
  });

  it("is false for garbage input", () => {
    expect(isTryCloudflareOrigin("nonsense")).toBe(false);
  });
});

describe("computeTunnelAllowedOrigins", () => {
  // Scenario 3
  it("adds the tunnel origin to an empty list", () => {
    const result = computeTunnelAllowedOrigins([], "https://a.trycloudflare.com/p");
    expect(result).toEqual({ origins: ["https://a.trycloudflare.com"], changed: true });
  });

  // Scenario 4
  it("preserves non-trycloudflare origins and prunes the stale trycloudflare one", () => {
    const existing = [LOOPBACK, "https://old.trycloudflare.com", "https://custom.example.com"];
    const result = computeTunnelAllowedOrigins(existing, "https://new.trycloudflare.com");
    expect(result.changed).toBe(true);
    expect(result.origins).toEqual([
      LOOPBACK,
      "https://custom.example.com",
      "https://new.trycloudflare.com",
    ]);
    expect(result.origins).not.toContain("https://old.trycloudflare.com");
  });

  // Scenario 5
  it("is a no-op when the current trycloudflare origin is already the only one", () => {
    const existing = [LOOPBACK, "https://a.trycloudflare.com"];
    const result = computeTunnelAllowedOrigins(existing, "https://a.trycloudflare.com");
    expect(result.changed).toBe(false);
    expect(result.origins).toEqual([LOOPBACK, "https://a.trycloudflare.com"]);
  });

  // Scenario 6
  it("prunes multiple stale trycloudflare origins and keeps only the current one", () => {
    const existing = ["https://one.trycloudflare.com", LOOPBACK, "https://two.trycloudflare.com"];
    const result = computeTunnelAllowedOrigins(existing, "https://three.trycloudflare.com");
    expect(result.changed).toBe(true);
    expect(result.origins).toEqual([LOOPBACK, "https://three.trycloudflare.com"]);
  });

  // Scenario 7
  it("returns the normalized existing list unchanged for an unparseable URL", () => {
    const existing = [LOOPBACK, 42, null, "https://custom.example.com"] as unknown;
    const result = computeTunnelAllowedOrigins(existing, "not-a-url");
    expect(result.changed).toBe(false);
    // Non-string entries are dropped by normalization.
    expect(result.origins).toEqual([LOOPBACK, "https://custom.example.com"]);
  });
});

describe("registerTunnelOrigin", () => {
  it("writes tunnel origins to the sandbox's recorded gateway", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-other-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-other-workspace");
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [LOOPBACK] } },
    };
    const { resolveAgentConfig, readConfig, reloadGateway, info, warn } = makeDeps(config);

    await registerTunnelOrigin("sb", "https://good.trycloudflare.com/route", {
      resolveRuntimeSelection: () => RUNTIME,
      resolveAgentConfig,
      readConfig,
      reloadGateway,
      info,
      warn,
    });

    expect(setOpenClawConfigValue).toHaveBeenCalledWith(
      "sb",
      "gateway.controlUi.allowedOrigins",
      [LOOPBACK, "https://good.trycloudflare.com"],
      RUNTIME,
    );
    expect(reloadGateway).toHaveBeenCalledTimes(1);
    expect(readConfig).toHaveBeenCalledWith("sb", OPENCLAW_TARGET, RUNTIME);
    expect(reloadGateway).toHaveBeenCalledWith("sb", RUNTIME);
  });

  it("reports a failed restart on the same recorded runtime after writing the origin", async () => {
    const restart = vi.spyOn(recovery, "restartSandboxGateway").mockResolvedValue({
      ok: false,
      failureLayer: "health timeout",
      detail: "gateway health probe failed",
    });
    const { deps, warn, writeAllowedOrigins } = makeDeps({});
    const { reloadGateway: _reload, ...withDefaultReload } = deps;
    try {
      await registerTunnelOrigin("sb", "https://good.trycloudflare.com", withDefaultReload);
      expect(writeAllowedOrigins).toHaveBeenCalledWith(
        "sb",
        ["https://good.trycloudflare.com"],
        RUNTIME,
      );
      expect(restart).toHaveBeenCalledExactlyOnceWith("sb", { runtimeSelection: RUNTIME });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("restart failed"));
    } finally {
      restart.mockRestore();
    }
  });

  it("does not read or mutate a sandbox when its recorded target is unavailable", async () => {
    const { deps, readConfig, writeAllowedOrigins, reloadGateway, warn } = makeDeps({});
    deps.resolveRuntimeSelection = () => {
      throw new Error("recorded target unavailable");
    };
    await registerTunnelOrigin("sb", "https://good.trycloudflare.com", deps);
    expect(readConfig).not.toHaveBeenCalled();
    expect(writeAllowedOrigins).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recorded target unavailable"));
  });

  // Scenario 8
  it("writes the tunnel origin through native config and reloads once", async () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [LOOPBACK] } },
    };
    const { deps, writeAllowedOrigins, reloadGateway } = makeDeps(config);

    await registerTunnelOrigin("sb", "https://good.trycloudflare.com/route", deps);

    expect(writeAllowedOrigins).toHaveBeenCalledWith(
      "sb",
      [LOOPBACK, "https://good.trycloudflare.com"],
      RUNTIME,
    );
    expect(reloadGateway).toHaveBeenCalledTimes(1);
    expect(reloadGateway).toHaveBeenCalledWith("sb", RUNTIME);
  });

  // Scenario 9
  it("skips the write and reload when the origin is already registered", async () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: ["https://good.trycloudflare.com"] } },
    };
    const { deps, writeAllowedOrigins, reloadGateway, info } = makeDeps(config);

    await registerTunnelOrigin("sb", "https://good.trycloudflare.com", deps);

    expect(writeAllowedOrigins).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("already registered"));
  });

  // Scenario 10
  it("skips entirely for a non-OpenClaw agent", async () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [] } },
    };
    const hermesTarget: AgentConfigTarget = { ...OPENCLAW_TARGET, agentName: "hermes" };
    const { deps, readConfig, writeAllowedOrigins, reloadGateway, info } = makeDeps(
      config,
      hermesTarget,
    );

    await registerTunnelOrigin("sb", "https://good.trycloudflare.com", deps);

    expect(readConfig).not.toHaveBeenCalled();
    expect(writeAllowedOrigins).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("OpenClaw-only"));
  });

  // Scenario 11
  it("swallows a read failure with a warning and does not throw", async () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [] } },
    };
    const { deps, readConfig, writeAllowedOrigins, reloadGateway, warn } = makeDeps(config);
    readConfig.mockImplementation(() => {
      throw new Error("sandbox not running");
    });

    await expect(
      registerTunnelOrigin("sb", "https://good.trycloudflare.com", deps),
    ).resolves.toBeUndefined();
    expect(writeAllowedOrigins).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not register tunnel origin"));
  });

  // Scenario 12
  it("returns immediately for a null origin without invoking any dep", async () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [] } },
    };
    const { deps, resolveAgentConfig, readConfig, writeAllowedOrigins, reloadGateway } =
      makeDeps(config);

    await registerTunnelOrigin("sb", "", deps);

    expect(resolveAgentConfig).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
    expect(writeAllowedOrigins).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
  });

  // Scenario 13
  it("writes only the native allowedOrigins key without carrying sibling credentials", async () => {
    const config: ConfigObject = {
      gateway: { auth: { token: "t" }, controlUi: { allowedOrigins: [] } },
    };
    const { deps, writeAllowedOrigins } = makeDeps(config);

    await registerTunnelOrigin("sb", "https://a.trycloudflare.com", deps);

    expect(writeAllowedOrigins).toHaveBeenCalledWith(
      "sb",
      ["https://a.trycloudflare.com"],
      RUNTIME,
    );
  });
});
