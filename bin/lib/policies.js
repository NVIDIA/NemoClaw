// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const mod = require("../../dist/lib/policies");
module.exports = {
  PRESETS_DIR: mod.PRESETS_DIR,
  listPresets: mod.listPresets,
  loadPreset: mod.loadPreset,
  getPresetEndpoints: mod.getPresetEndpoints,
  extractPresetEntries: mod.extractPresetEntries,
  parseCurrentPolicy: mod.parseCurrentPolicy,
  buildPolicySetCommand: mod.buildPolicySetCommand,
  buildPolicyGetCommand: mod.buildPolicyGetCommand,
  mergePresetIntoPolicy: mod.mergePresetIntoPolicy,
  applyPreset: mod.applyPreset,
  getAppliedPresets: mod.getAppliedPresets,
  selectFromList: mod.selectFromList,
};
