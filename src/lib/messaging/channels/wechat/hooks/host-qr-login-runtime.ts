// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { saveCredential } from "../../../../credentials/store";
import { runWechatHostQrLogin, type WechatLoginResult as WechatHostQrLoginResult } from "../login";
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

    const result: WechatHostQrLoginResult = await runWechatHostQrLogin();

    if (result.kind !== "ok") {
      return result;
    }

    return {
      kind: "ok",
      summary: `account ${result.credentials.accountId}`,
      credentials: result.credentials,
    };
  };
}

function logEnrollmentHelp(): void {
  const help = wechatManifest.enrollmentHelp ?? wechatManifest.inputs[0]?.prompt?.help;
  if (!help) return;
  console.log("");
  console.log(`  ${help}`);
}
