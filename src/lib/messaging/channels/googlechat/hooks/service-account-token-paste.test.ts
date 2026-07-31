// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

import { runMessagingHook } from "../../../hooks/hook-runner";
import { MessagingHookRegistry } from "../../../hooks/registry";
import { googlechatManifest } from "../manifest";
import {
  createGooglechatTokenPasteHookRegistration,
  GOOGLECHAT_TOKEN_PASTE_HOOK_HANDLER_ID,
  serviceAccountJsonError,
} from "./service-account-token-paste";

const serviceAccountHook = googlechatManifest.hooks.find(
  (hook) => hook.handler === GOOGLECHAT_TOKEN_PASTE_HOOK_HANDLER_ID,
);
assert(serviceAccountHook, "missing Google Chat service-account hook");

const validServiceAccount = JSON.stringify({
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key: "synthetic-test-private-key-material",
});

describe("Google Chat service-account enrollment", () => {
  it("accepts JSON with the refresh material required by the gateway", () => {
    expect(serviceAccountJsonError(validServiceAccount)).toBeNull();
  });

  it.each([
    ["invalid JSON", "not-json", "could not be parsed"],
    ["an array", "[]", "must be an object"],
    ["a null value", "null", "must be an object"],
    ["missing client_email", JSON.stringify({ private_key: "key" }), "must include"],
    ["missing private_key", JSON.stringify({ client_email: "bot@example" }), "must include"],
    [
      "blank required fields",
      JSON.stringify({ client_email: " ", private_key: "\n" }),
      "must include",
    ],
  ])("rejects %s before saving the secret", (_case, value, message) => {
    expect(serviceAccountJsonError(value)).toContain(message);
  });

  it.each([
    "environment",
    "credential store",
  ] as const)("rejects malformed existing JSON from the %s before persistence", async (source) => {
    const env: NodeJS.ProcessEnv =
      source === "environment" ? { GOOGLECHAT_SERVICE_ACCOUNT: "not-json" } : {};
    const saveCredential = vi.fn();
    const prompt = vi.fn();
    const registry = new MessagingHookRegistry([
      createGooglechatTokenPasteHookRegistration({
        env,
        getCredential: () => (source === "credential store" ? "not-json" : null),
        saveCredential,
        prompt,
        log: () => {},
      }),
    ]);

    await expect(
      runMessagingHook(serviceAccountHook, registry, {
        channelId: "googlechat",
        isInteractive: false,
      }),
    ).rejects.toThrow("Service account JSON could not be parsed");
    expect(prompt).not.toHaveBeenCalled();
    expect(saveCredential).not.toHaveBeenCalled();
  });

  it("ignores malformed existing JSON interactively and persists a valid replacement", async () => {
    const env: NodeJS.ProcessEnv = {};
    const saveCredential = vi.fn();
    const prompt = vi.fn().mockResolvedValue(validServiceAccount);
    const registry = new MessagingHookRegistry([
      createGooglechatTokenPasteHookRegistration({
        env,
        getCredential: () => "not-json",
        saveCredential,
        prompt,
        log: () => {},
      }),
    ]);

    await expect(
      runMessagingHook(serviceAccountHook, registry, {
        channelId: "googlechat",
        isInteractive: true,
      }),
    ).resolves.toMatchObject({
      outputs: {
        serviceAccount: {
          kind: "secret",
          value: validServiceAccount,
        },
      },
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(saveCredential).toHaveBeenCalledWith("GOOGLECHAT_SERVICE_ACCOUNT", validServiceAccount);
    expect(env.GOOGLECHAT_SERVICE_ACCOUNT).toBe(validServiceAccount);
  });
});
