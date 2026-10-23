// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenClawConfig } from "./index.js";

export function configuredSearchEnabled(config: OpenClawConfig): boolean | undefined {
  // Read only the enable flag. Provider configuration can contain credentials.
  const tools = config.tools;
  const web = tools && typeof tools === "object" && !Array.isArray(tools) ? tools.web : undefined;
  const search = web && typeof web === "object" && !Array.isArray(web) ? web.search : undefined;
  const enabled =
    search && typeof search === "object" && !Array.isArray(search) ? search.enabled : undefined;
  return typeof enabled === "boolean" ? enabled : undefined;
}
