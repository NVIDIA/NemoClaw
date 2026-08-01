// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export function openClawBootstrapSnippet(
  startScriptPath: string,
  entrypointEnvWrapperPath: string,
): string {
  const source = fs.readFileSync(startScriptPath, "utf8");
  const entrypointStart = source.indexOf("# managed-entrypoint-env-wrapper begin");
  const entrypointEndMarker = "# managed-entrypoint-env-wrapper end";
  const entrypointEnd = source.indexOf(entrypointEndMarker, entrypointStart);
  const environmentStart = source.indexOf('NEMOCLAW_CMD=("$@")');
  const environmentEnd = source.indexOf(
    "# Marker file the Docker HEALTHCHECK reads",
    environmentStart,
  );
  const dashboardStart = source.indexOf("_chat_ui_url_port() {");
  const dashboardEnd = source.indexOf("# ── Config integrity check", dashboardStart);
  if (
    entrypointStart === -1 ||
    entrypointEnd === -1 ||
    environmentStart === -1 ||
    environmentEnd <= environmentStart ||
    dashboardStart === -1 ||
    dashboardEnd <= dashboardStart
  ) {
    throw new Error("Expected entrypoint normalization and dashboard port blocks");
  }
  const entrypoint = source
    .slice(entrypointStart, entrypointEnd + entrypointEndMarker.length)
    .replace("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh", entrypointEnvWrapperPath);
  return [
    entrypoint,
    source.slice(environmentStart, environmentEnd),
    source.slice(dashboardStart, dashboardEnd),
  ].join("\n");
}
