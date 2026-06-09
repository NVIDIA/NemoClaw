// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { saveCredential } from "../../../../credentials/store";
import { HOST_QR_LOGIN_HANDLERS, type HostQrLoginResult } from "../../../../host-qr-handlers";
import { wechatManifest } from "../manifest";
import type { WechatIlinkLoginHookOptions, WechatLoginResult } from "./ilink-login";

export function createDefaultWechatHostQrLoginOptions(): WechatIlinkLoginHookOptions {
  return {
    saveCredential,
    runLogin: createWechatHostQrLoginRunner(),
  };
}

function createWechatHostQrLoginRunner(): () => Promise<WechatLoginResult> {
  return async () => {
    logEnrollmentHelp();
    const handler = HOST_QR_LOGIN_HANDLERS.wechat;
    if (!handler) return { kind: "error", message: "no host-qr handler registered" };

    let result: HostQrLoginResult;
    try {
      result = await handler();
    } catch (error) {
      result = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }

    if (result.kind !== "ok") {
      return result.kind === "error"
        ? { kind: "error", message: result.message }
        : { kind: result.kind };
    }
    if (!result.token) {
      return { kind: "error", message: "host-qr handler returned no token" };
    }

    const accountId = result.extraEnv?.WECHAT_ACCOUNT_ID;
    if (!accountId) {
      return { kind: "error", message: "host-qr handler returned no WeChat account id" };
    }

    return {
      kind: "ok",
      summary: result.summary,
      credentials: {
        token: result.token,
        accountId,
        baseUrl: result.extraEnv?.WECHAT_BASE_URL,
        userId: result.extraEnv?.WECHAT_USER_ID ?? result.defaultUserId,
      },
    };
  };
}

function logEnrollmentHelp(): void {
  const help = wechatManifest.enrollmentHelp ?? wechatManifest.inputs[0]?.prompt?.help;
  if (!help) return;
  console.log("");
  console.log(`  ${help}`);
}
