// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Thin re-export shim — the implementation lives in src/lib/tiers.ts,
// compiled to dist/lib/tiers.js.

const mod = require("../../dist/lib/tiers");
module.exports = {
  TIERS_FILE: mod.TIERS_FILE,
  listTiers: mod.listTiers,
  getTier: mod.getTier,
  resolveTierPresets: mod.resolveTierPresets,
};
