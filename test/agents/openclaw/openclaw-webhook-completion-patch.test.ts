// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  patchWebhookCompletionText,
  WEBHOOK_COMPLETION_READ,
} from "../../../scripts/lib/patch-openclaw-webhook-completion.mts";

function readCompletion(
  configMarker: unknown,
  machineRead: (key: string, options: unknown, behavior: unknown) => unknown,
) {
  const env = { OPENCLAW_CONFIG_PATH: "/fixture/selected.json" };
  const resolvePath = vi.fn(() => env.OPENCLAW_CONFIG_PATH);
  const value: unknown = runInNewContext(`${WEBHOOK_COMPLETION_READ}\nwebhookCompletion;`, {
    read: {
      snapshot: { sourceConfig: { meta: { migrations: { webhookListeners: configMarker } } } },
    },
    env,
    nemoclawResolveConfigPath: resolvePath,
    nemoclawReadConfigMachineState: machineRead,
  });
  return { value, env, resolvePath };
}

describe("native webhook completion", () => {
  it.each([true, false, {}, { telegram: [] }])(
    "preserves authored completion precedence: %j",
    (marker) => {
      const nativeRead = vi.fn(() => {
        throw new Error("must not read machine state");
      });
      expect(readCompletion(marker, nativeRead).value).toBe(marker);
      expect(nativeRead).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null])(
    "uses the selected config's native record when metadata is %j",
    (marker) => {
      const nativeRead = vi.fn(() => true);
      const result = readCompletion(marker, nativeRead);
      expect(result.value).toBe(true);
      expect(result.resolvePath).toHaveBeenCalledExactlyOnceWith(result.env);
      expect(nativeRead).toHaveBeenCalledExactlyOnceWith(
        "webhookListeners:/fixture/selected.json",
        { env: result.env },
        { artifactPreservingReadOnly: true },
      );
    },
  );

  it.each([undefined, false, {}, { telegram: [] }])(
    "does not invent completion for a missing or partial native record: %j",
    (record) => {
      expect(readCompletion(undefined, () => record).value).toBe(record);
    },
  );

  it("propagates native read failures instead of skipping readiness", () => {
    expect(() =>
      readCompletion(undefined, () => {
        throw new Error("state unavailable");
      }),
    ).toThrow("state unavailable");
  });

  it("refuses source that does not match the reviewed bundle", () => {
    expect(() => patchWebhookCompletionText("const webhookCompletion = true;")).toThrow(
      "differs from the reviewed",
    );
  });
});
