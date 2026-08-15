// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { MessagingHookContext } from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  createGooglechatTunnelAudienceGateHook,
  type GooglechatTunnelAudienceGateHookOptions,
} from "./tunnel-audience-gate";

function gateContext(
  inputs: Record<string, MessagingSerializableValue>,
  isInteractive = true,
): MessagingHookContext {
  return {
    channelId: "googlechat",
    hookId: "googlechat-tunnel-audience-gate",
    phase: "enroll",
    isInteractive,
    inputs,
  };
}

function baseOptions(
  overrides: Partial<GooglechatTunnelAudienceGateHookOptions> = {},
): GooglechatTunnelAudienceGateHookOptions {
  return {
    env: {},
    log: () => {},
    hasCloudflared: () => true,
    readTunnelState: () => ({ running: false }),
    startTunnel: async () => {},
    stopTunnel: vi.fn(),
    getTunnelUrl: () => "https://abc.trycloudflare.com",
    prompt: async () => "y",
    ...overrides,
  };
}

describe("googlechat tunnel/audience gate hook", () => {
  it("ignores non-googlechat channels", async () => {
    const hook = createGooglechatTunnelAudienceGateHook(baseOptions());
    const result = await hook({ ...gateContext({}), channelId: "slack" });
    expect(result).toEqual({});
  });

  it("uses a valid pre-supplied app-url audience without touching the tunnel", async () => {
    const startTunnel = vi.fn(async () => {});
    const stopTunnel = vi.fn();
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({ startTunnel, stopTunnel, readTunnelState: () => ({ running: false }) }),
    );

    const result = await hook(gateContext({ audience: "https://named.example.com/googlechat" }));

    expect(result).toEqual({
      outputs: {
        audience: { kind: "config", value: "https://named.example.com/googlechat" },
      },
    });
    expect(startTunnel).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it.each([
    "https://named.example.com/other",
    "https://named.example.com/googlechat/",
    "https://named.example.com/hooks/googlechat",
    "http://named.example.com/googlechat",
  ])("rejects an invalid pre-supplied app-url audience: %s", async (audience) => {
    const startTunnel = vi.fn(async () => {});
    const hook = createGooglechatTunnelAudienceGateHook(baseOptions({ startTunnel }));

    await expect(hook(gateContext({ audience }))).rejects.toThrow(/path is exactly \/googlechat/);
    expect(startTunnel).not.toHaveBeenCalled();
  });

  it("collects a non app-url audience directly, without touching the tunnel", async () => {
    const startTunnel = vi.fn(async () => {});
    const prompt = vi.fn(async () => "123456789012");
    const hook = createGooglechatTunnelAudienceGateHook(baseOptions({ startTunnel, prompt }));

    const result = await hook(gateContext({ audienceType: "project-number" }));

    expect(result).toEqual({
      outputs: { audience: { kind: "config", value: "123456789012" } },
    });
    expect(startTunnel).not.toHaveBeenCalled();
  });

  it("preserves a pre-supplied project-number audience", async () => {
    const prompt = vi.fn(async () => "unused");
    const hook = createGooglechatTunnelAudienceGateHook(baseOptions({ prompt }));

    const result = await hook(
      gateContext({ audienceType: "project-number", audience: "123456789012" }),
    );

    expect(result).toEqual({
      outputs: { audience: { kind: "config", value: "123456789012" } },
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("skips googlechat when a non app-url audience is left blank", async () => {
    const prompt = vi.fn(async () => "");
    const hook = createGooglechatTunnelAudienceGateHook(baseOptions({ prompt }));

    await expect(hook(gateContext({ audienceType: "project-number" }))).rejects.toThrow(
      /No Google Chat webhook audience provided/,
    );
  });

  it("always skips (throws) in non-interactive mode, even with an explicit audience", async () => {
    const startTunnel = vi.fn(async () => {});
    const stopTunnel = vi.fn();
    const hook = createGooglechatTunnelAudienceGateHook(baseOptions({ startTunnel, stopTunnel }));

    // No audience → skip.
    await expect(hook(gateContext({}, false))).rejects.toThrow(/interactive enrollment required/);
    // A pre-supplied audience does NOT bypass the skip: the Google Cloud Console
    // endpoint + appPrincipal steps still need an operator, so Google Chat is
    // unconditionally skipped in non-interactive mode (mirrors WeChat host QR).
    await expect(
      hook(gateContext({ audience: "https://named.example.com/googlechat" }, false)),
    ).rejects.toThrow(/interactive enrollment required/);
    // Never touches the tunnel in non-interactive mode.
    expect(startTunnel).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it("skips when cloudflared is not installed and never starts a tunnel", async () => {
    const startTunnel = vi.fn(async () => {});
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({ hasCloudflared: () => false, startTunnel }),
    );
    await expect(hook(gateContext({}))).rejects.toThrow(/cloudflared is not installed/);
    expect(startTunnel).not.toHaveBeenCalled();
  });

  it("starts a tunnel, derives the audience, and keeps the tunnel on confirmation", async () => {
    let running = false;
    const env: NodeJS.ProcessEnv = {};
    const stopTunnel = vi.fn();
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({
        env,
        readTunnelState: () => ({ running }),
        startTunnel: async () => {
          running = true;
        },
        // Trailing slash must be stripped before appending the webhook path.
        getTunnelUrl: () => "https://abc.trycloudflare.com/",
        prompt: async () => "yes",
        stopTunnel,
      }),
    );

    const result = await hook(gateContext({}));

    expect(result).toEqual({
      outputs: { audience: { kind: "config", value: "https://abc.trycloudflare.com/googlechat" } },
    });
    expect(env.GOOGLECHAT_AUDIENCE).toBe("https://abc.trycloudflare.com/googlechat");
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it("stops a self-started tunnel when the operator declines", async () => {
    let running = false;
    const stopTunnel = vi.fn();
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({
        readTunnelState: () => ({ running }),
        startTunnel: async () => {
          running = true;
        },
        prompt: async () => "n",
        stopTunnel,
      }),
    );

    await expect(hook(gateContext({}))).rejects.toThrow(/did not confirm/);
    expect(stopTunnel).toHaveBeenCalledTimes(1);
  });

  it("never stops a pre-existing tunnel on decline", async () => {
    const startTunnel = vi.fn(async () => {});
    const stopTunnel = vi.fn();
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({
        readTunnelState: () => ({ running: true }),
        startTunnel,
        prompt: async () => "n",
        stopTunnel,
      }),
    );

    await expect(hook(gateContext({}))).rejects.toThrow(/did not confirm/);
    expect(startTunnel).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it("enrolls non-interactively only when the live composition injects an audience capability", async () => {
    const startTunnel = vi.fn(async () => {});
    const stopTunnel = vi.fn();
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({
        nonInteractiveAudienceCapability: {
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        startTunnel,
        stopTunnel,
      }),
    );

    const result = await hook(gateContext({}, false));

    expect(result).toEqual({
      outputs: {
        audience: { kind: "config", value: "https://e2e-fake.trycloudflare.com/googlechat" },
      },
    });
    // The capability stands in for the live tunnel + Console confirmation, so neither runs.
    expect(startTunnel).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it("ignores environment and configured audiences without an explicit capability", async () => {
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({
        env: {
          E2E_TARGET_ID: "channels-stop-start",
          GOOGLECHAT_AUDIENCE: "https://e2e-fake.trycloudflare.com/googlechat",
          NEMOCLAW_E2E_ALLOW_GOOGLECHAT_PRESET_AUDIENCE: "1",
          NEMOCLAW_RUN_LIVE_E2E: "1",
        },
      }),
    );

    await expect(
      hook(gateContext({ audience: "https://configured.example.com/googlechat" }, false)),
    ).rejects.toThrow(/interactive enrollment required/);
  });

  it("still validates the audience shape carried by the live capability", async () => {
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({
        nonInteractiveAudienceCapability: {
          audience: "https://e2e-fake.trycloudflare.com/other",
        },
      }),
    );

    await expect(hook(gateContext({}, false))).rejects.toThrow(/path is exactly \/googlechat/);
  });

  it("still skips non-interactively when the live capability has no audience", async () => {
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({ nonInteractiveAudienceCapability: { audience: " " } }),
    );

    await expect(hook(gateContext({}, false))).rejects.toThrow(/interactive enrollment required/);
  });

  it("does not honor the removed runtime skip environment variable", async () => {
    const hook = createGooglechatTunnelAudienceGateHook(
      baseOptions({ env: { NEMOCLAW_SKIP_GOOGLECHAT_TUNNEL: "1" } }),
    );

    await expect(
      hook(gateContext({ audience: "https://e2e-fake.trycloudflare.com/googlechat" }, false)),
    ).rejects.toThrow(/interactive enrollment required/);
  });
});
