// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { REPOSITORY_ROOT } from "../../core/repository-root";

const NEMOCLAW_GATEWAY_UNIT_TEMPLATE_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts/lib/openshell-gateway.service.in",
);

/** Match the complete repository-owned user service definition. */
export function matchesNemoclawGatewaySystemdUnit(
  contents: string,
  gatewayBinary: string,
): boolean {
  try {
    const template = fs.readFileSync(NEMOCLAW_GATEWAY_UNIT_TEMPLATE_PATH, "utf8");
    return contents === template.replaceAll("@OPENSHELL_GATEWAY_BIN@", gatewayBinary);
  } catch {
    return false;
  }
}
