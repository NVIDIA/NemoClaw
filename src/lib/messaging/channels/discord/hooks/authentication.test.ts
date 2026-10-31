// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createBuiltInChannelManifestRegistry, createBuiltInRenderTemplateResolver } from "../..";
import { ManifestCompiler } from "../../../compiler/manifest-compiler";
import { createBuiltInMessagingHookRegistry } from "../../../hooks";
import { createDiscordAuthenticationHook } from "./authentication";

describe("Discord enrollment", () => {
  it.each(["onboard", "add-channel"] as const)(
    "keeps Discord inactive after HTTP 401 during %s (#13809)",
    async (workflow) => {
      const token = "invalid-token-for-test";
      const fetch = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
      vi.stubGlobal("fetch", fetch);
      const plan = await new ManifestCompiler(
        createBuiltInChannelManifestRegistry(),
        createBuiltInMessagingHookRegistry({
          common: { env: { DISCORD_BOT_TOKEN: token }, log: () => {} },
        }),
        createBuiltInRenderTemplateResolver(),
      ).compile({
        sandboxName: "demo",
        agent: "hermes",
        workflow,
        isInteractive: false,
        configuredChannels: ["discord"],
      });
      expect(plan.channels[0]).toMatchObject({ active: false, configured: false, disabled: true });
      expect(plan.agentRender).toEqual([]);
      expect(JSON.stringify(plan)).not.toContain(token);
    },
  );
});

describe("Discord authentication", () => {
  const context = {
    channelId: "discord",
    hookId: "discord-token-paste",
    phase: "enroll" as const,
    inputs: { botToken: "invalid-token-for-test" },
  };

  it("verifies bot identity without returning or logging the token (#13809)", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ id: "123", bot: true }));
    const log = vi.fn();
    const hook = createDiscordAuthenticationHook({ fetch: request, log });
    await expect(hook(context)).resolves.toEqual({});
    expect(request).toHaveBeenCalledWith("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: "Bot invalid-token-for-test",
        "User-Agent": expect.stringMatching(
          /^DiscordBot \(https:\/\/github.com\/NVIDIA\/NemoClaw, [^)]+\)$/,
        ),
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(context.inputs.botToken);
  });

  it.each(["nemoclaw", "nemohermes"])(
    "gives a complete %s recovery command after token rejection (#13809)",
    async (cli) => {
      vi.stubEnv("NEMOCLAW_INVOKED_AS", cli);
      try {
        const hook = createDiscordAuthenticationHook({
          fetch: async () => new Response("Unauthorized", { status: 401 }),
          log: () => {},
        });
        await expect(hook(context)).rejects.toThrow(
          `Run ${cli} <sandbox-name> channels add discord`,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([401, 403, 429, 500, 302])(
    "leaves enrollment inactive after HTTP %s (#13809)",
    async (status) => {
      const log = vi.fn();
      const hook = createDiscordAuthenticationHook({
        fetch: async () => new Response(context.inputs.botToken, { status }),
        log,
      });
      await expect(hook(context)).rejects.toThrow(
        status === 401
          ? "Discord rejected"
          : status === 429
            ? "rate-limited"
            : "could not be verified",
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(context.inputs.botToken);
    },
  );

  it.each(["not-json", "{}", '{"bot":false,"id":"123"}', "x".repeat(16_385)])(
    "rejects an invalid identity response %# (#13809)",
    async (body) => {
      await expect(
        createDiscordAuthenticationHook({ fetch: async () => new Response(body), log: () => {} })(
          context,
        ),
      ).rejects.toThrow("could not be verified");
    },
  );

  it("redacts transport errors and allows a later successful enrollment (#13809)", async () => {
    const log = vi.fn();
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(context.inputs.botToken))
      .mockResolvedValueOnce(Response.json({ bot: true, id: "123" }));
    const hook = createDiscordAuthenticationHook({ fetch: request, log });
    await expect(hook(context)).rejects.toThrow("could not be verified");
    await expect(hook(context)).resolves.toEqual({});
    expect(JSON.stringify(log.mock.calls)).not.toContain(context.inputs.botToken);
  });

  it.each(["request", "body"])("bounds a hung %s and aborts it (#13809)", async (stage) => {
    let signal: AbortSignal | null | undefined;
    const hook = createDiscordAuthenticationHook({
      timeoutMs: 5,
      log: () => {},
      fetch: async (_url, options) => {
        signal = options?.signal;
        return stage === "request"
          ? await new Promise<Response>(() => {})
          : new Response(new ReadableStream({ start() {} }));
      },
    });
    await expect(hook(context)).rejects.toThrow("could not be verified");
    expect(signal?.aborted).toBe(true);
  });
});
