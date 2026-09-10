// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath as nativeEntryFile } from "node:url";
declare const NEMOCLAW_BUNDLED_RUNTIME: boolean | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeWebSession } from "./native-web-session.mts";
import { runNativeConsoleAgent } from "./run-installed-native-console-agent.mts";

export async function runNativeHermesUiEntry() {
  let session;
  let passed = false;
  try {
    session = await openNativeWebSession(
      process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
      "hermes",
      undefined,
      { qualification: process.argv.includes("--dashboard-qualification") },
    );
    await runNativeConsoleAgent({ interface: "dashboard", webSession: session });
    passed = true;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "The native Hermes Web UI could not finish its session.",
    );
    process.exitCode = 1;
  } finally {
    if (session)
      await session.complete(passed).catch(() => {
        process.exitCode = 1;
      });
  }
}

if (
  typeof NEMOCLAW_BUNDLED_RUNTIME === "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === nativeEntryFile(import.meta.url)
) {
  void runNativeHermesUiEntry();
}
