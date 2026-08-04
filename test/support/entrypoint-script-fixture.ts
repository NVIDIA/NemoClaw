// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export function openClawBootstrapSnippet(startScriptPath: string): string {
  const source = fs.readFileSync(startScriptPath, "utf8");
  const environmentStart = source.indexOf("# Normalize the sandbox-create bootstrap wrapper");
  const environmentEnd = source.indexOf(
    "# Marker file the Docker HEALTHCHECK reads",
    environmentStart,
  );
  const dashboardStart = source.indexOf("_chat_ui_url_port() {");
  const dashboardEnd = source.indexOf("# ── Config integrity check", dashboardStart);
  if (
    environmentStart === -1 ||
    environmentEnd <= environmentStart ||
    dashboardStart === -1 ||
    dashboardEnd <= dashboardStart
  ) {
    throw new Error("Expected wrapper normalization and dashboard port blocks");
  }
  return [
    source.slice(environmentStart, environmentEnd),
    source.slice(dashboardStart, dashboardEnd),
  ].join("\n");
}
