// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createDiscordMessageApi, inspectAuthorization } from "../lib/fake-discord-message-api.mts";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("fake Discord message API", () => {
  it("classifies the expected token separately from an unresolved placeholder", () => {
    expect(inspectAuthorization("Bot fixture-token", "fixture-token")).toMatchObject({
      authorizationSchemeValid: true,
      tokenMatchesExpected: true,
      tokenLooksPlaceholder: false,
    });
    expect(
      inspectAuthorization("Bot openshell:resolve:env:v1_DISCORD_BOT_TOKEN", "fixture-token"),
    ).toMatchObject({
      authorizationSchemeValid: true,
      tokenMatchesExpected: false,
      tokenLooksPlaceholder: true,
    });
  });

  it("parses long malformed Bot authorization input in one pass", () => {
    expect(inspectAuthorization(`Bot${"\t".repeat(100_000)}`, "fixture-token")).toMatchObject({
      authorizationPresent: true,
      authorizationSchemeValid: false,
      tokenMatchesExpected: false,
      tokenLooksPlaceholder: false,
    });
    expect(inspectAuthorization("bOt \t fixture-token", "fixture-token")).toMatchObject({
      authorizationSchemeValid: true,
      tokenMatchesExpected: true,
    });
  });

  it("accepts users/@me only after the expected non-placeholder token reaches it", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const server = createDiscordMessageApi("fixture-token", (event) => captures.push(event));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;

    const placeholder = await fetch(`http://127.0.0.1:${String(port)}/api/v10/users/@me`, {
      headers: { authorization: "Bot openshell:resolve:env:v1_DISCORD_BOT_TOKEN" },
    });
    const expected = await fetch(`http://127.0.0.1:${String(port)}/api/v10/users/@me`, {
      headers: { authorization: "Bot fixture-token" },
    });

    expect(placeholder.status).toBe(401);
    expect(expected.status).toBe(200);
    expect(captures).toEqual([
      expect.objectContaining({ tokenMatchesExpected: false, tokenLooksPlaceholder: true }),
      expect.objectContaining({ tokenMatchesExpected: true, tokenLooksPlaceholder: false }),
    ]);
    expect(JSON.stringify(captures)).not.toContain("fixture-token");
  });
});
