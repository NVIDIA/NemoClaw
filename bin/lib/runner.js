// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const distPath = require.resolve("../../dist/lib/runner");
delete require.cache[distPath];
const mod = require(distPath);
module.exports = {
  ROOT: mod.ROOT,
  SCRIPTS: mod.SCRIPTS,
  redact: mod.redact,
  run: mod.run,
  runCapture: mod.runCapture,
  runInteractive: mod.runInteractive,
  shellQuote: mod.shellQuote,
  validateName: mod.validateName,
};
