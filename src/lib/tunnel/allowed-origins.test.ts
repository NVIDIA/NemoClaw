// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentConfigTarget } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
// Import source directly so tests cannot pass against a stale build.
import {
  computeTunnelAllowedOrigins,
  isTryCloudflareOrigin,
  type RegisterTunnelOriginDeps,
  registerTunnelOrigin,
  tunnelUrlToOrigin,
} from "./allowed-origins";

const LOOPBACK = "http://127.0.0.1:18789";

const OPENCLAW_TARGET: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
};

/**
 * Build a fully-injected dep set backed by spies. Passing every dep keeps
 * `resolveDeps` from requiring the real sandbox/config module, so no test here
 * ever touches openshell/docker.
 */
function makeDeps(config: ConfigObject, target: AgentConfigTarget = OPENCLAW_TARGET) {
  const resolveAgentConfig = vi.fn((_sb: string): AgentConfigTarget => target);
  const readConfig = vi.fn((_sb: string, _t: AgentConfigTarget): ConfigObject => config);
  const writeConfig = vi.fn((_sb: string, _t: AgentConfigTarget, _c: ConfigObject): void => {});
  const recomputeHash = vi.fn((_sb: string, _t: AgentConfigTarget): void => {});
  const reloadGateway = vi.fn((_sb: string): void => {});
  const info = vi.fn((_msg: string): void => {});
  const warn = vi.fn((_msg: string): void => {});
  const deps: RegisterTunnelOriginDeps = {
    resolveAgentConfig,
    readConfig,
    writeConfig,
    recomputeHash,
    reloadGateway,
    info,
    warn,
  };
  return {
    deps,
    resolveAgentConfig,
    readConfig,
    writeConfig,
    recomputeHash,
    reloadGateway,
    info,
    warn,
  };
}

function readOrigins(config: ConfigObject): unknown {
  const gateway = config.gateway as ConfigObject | undefined;
  const controlUi = gateway?.controlUi as ConfigObject | undefined;
  return controlUi?.allowedOrigins;
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
  // Scenario 8
  it("writes the tunnel origin, recomputes the hash, and reloads once", () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [LOOPBACK] } },
    };
    const { deps, writeConfig, recomputeHash, reloadGateway } = makeDeps(config);

    registerTunnelOrigin("sb", "https://good.trycloudflare.com/route", deps);

    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect(writeConfig).toHaveBeenCalledWith("sb", OPENCLAW_TARGET, expect.anything());
    const written = writeConfig.mock.calls[0][2];
    expect(readOrigins(written)).toEqual([LOOPBACK, "https://good.trycloudflare.com"]);
    expect(recomputeHash).toHaveBeenCalledTimes(1);
    expect(recomputeHash).toHaveBeenCalledWith("sb", OPENCLAW_TARGET);
    expect(reloadGateway).toHaveBeenCalledTimes(1);
    expect(reloadGateway).toHaveBeenCalledWith("sb");
  });

  // Scenario 9
  it("skips the write and reload when the origin is already registered", () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: ["https://good.trycloudflare.com"] } },
    };
    const { deps, writeConfig, recomputeHash, reloadGateway, info } = makeDeps(config);

    registerTunnelOrigin("sb", "https://good.trycloudflare.com", deps);

    expect(writeConfig).not.toHaveBeenCalled();
    expect(recomputeHash).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("already registered"));
  });

  // Scenario 10
  it("skips entirely for a non-OpenClaw agent", () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [] } },
    };
    const hermesTarget: AgentConfigTarget = { ...OPENCLAW_TARGET, agentName: "hermes" };
    const { deps, readConfig, writeConfig, reloadGateway, info } = makeDeps(config, hermesTarget);

    registerTunnelOrigin("sb", "https://good.trycloudflare.com", deps);

    expect(readConfig).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("OpenClaw-only"));
  });

  // Scenario 11
  it("swallows a read failure with a warning and does not throw", () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [] } },
    };
    const { deps, readConfig, writeConfig, reloadGateway, warn } = makeDeps(config);
    readConfig.mockImplementation(() => {
      throw new Error("sandbox not running");
    });

    expect(() => registerTunnelOrigin("sb", "https://good.trycloudflare.com", deps)).not.toThrow();
    expect(writeConfig).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not register tunnel origin"));
  });

  // Scenario 12
  it("returns immediately for a null origin without invoking any dep", () => {
    const config: ConfigObject = {
      gateway: { controlUi: { allowedOrigins: [] } },
    };
    const { deps, resolveAgentConfig, readConfig, writeConfig, reloadGateway } = makeDeps(config);

    registerTunnelOrigin("sb", "", deps);

    expect(resolveAgentConfig).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
    expect(reloadGateway).not.toHaveBeenCalled();
  });

  // Scenario 13
  it("preserves sibling gateway keys through the read-modify-write", () => {
    const config: ConfigObject = {
      gateway: { auth: { token: "t" }, controlUi: { allowedOrigins: [] } },
    };
    const { deps, writeConfig } = makeDeps(config);

    registerTunnelOrigin("sb", "https://a.trycloudflare.com", deps);

    expect(writeConfig).toHaveBeenCalledTimes(1);
    const written = writeConfig.mock.calls[0][2];
    const gateway = written.gateway as ConfigObject;
    const auth = gateway.auth as ConfigObject;
    expect(auth.token).toBe("t");
    expect(readOrigins(written)).toContain("https://a.trycloudflare.com");
  });
});
