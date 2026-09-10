// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeWebSession } from "./native-web-session.mts";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { runNativeConsoleAgent } = await import("./run-installed-native-console-agent.mts");
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
