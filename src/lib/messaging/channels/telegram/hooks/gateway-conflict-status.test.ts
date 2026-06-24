// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runMessagingHookSync } from "../../../hooks";
import { MessagingHookRegistry } from "../../../hooks/registry";
import {
  createTelegramGatewayConflictStatusHookRegistration,
  TELEGRAM_GATEWAY_CONFLICT_STATUS_HOOK_HANDLER_ID,
} from "./gateway-conflict-status";

const HOOK = {
  id: "telegram-gateway-conflict-status",
  phase: "status",
  handler: TELEGRAM_GATEWAY_CONFLICT_STATUS_HOOK_HANDLER_ID,
  outputs: [{ id: "bridgeHealth", kind: "status" }],
} as const;

describe("telegram.gatewayConflictStatus hook", () => {
  it("counts Telegram getUpdates/409 conflict signatures from the gateway log", () => {
    const executeSandboxCommand = vi.fn(() => ({
      status: 0,
      stdout: "getUpdates conflict\n409 Conflict\n409: Conflict\nunrelated\n",
    }));
    const registry = new MessagingHookRegistry([
      createTelegramGatewayConflictStatusHookRegistration({ executeSandboxCommand }),
    ]);

    const result = runMessagingHookSync(HOOK, registry, {
      channelId: "telegram",
      inputs: { currentSandbox: "alpha" },
    });

    expect(result.outputs.bridgeHealth).toEqual({
      kind: "status",
      value: {
        type: "messaging-bridge-health",
        channel: "telegram",
        conflicts: 3,
        logFile: "/tmp/gateway.log",
      },
    });
    expect(executeSandboxCommand).toHaveBeenCalledWith(
      "alpha",
      "tail -n 200 /tmp/gateway.log 2>/dev/null || true",
      3000,
    );
  });

  it("emits no status output when no conflict signature is present", () => {
    const registry = new MessagingHookRegistry([
      createTelegramGatewayConflictStatusHookRegistration({
        executeSandboxCommand: () => ({ status: 0, stdout: "provider ready\n" }),
      }),
    ]);

    expect(
      runMessagingHookSync(HOOK, registry, {
        channelId: "telegram",
        inputs: { currentSandbox: "alpha" },
      }).outputs,
    ).toEqual({});
  });
});
