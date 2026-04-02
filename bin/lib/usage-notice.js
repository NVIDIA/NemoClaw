// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Thin re-export shim — the implementation lives in src/lib/usage-notice.ts,
// compiled to dist/lib/usage-notice.js.
const usageNotice = require("../../dist/lib/usage-notice");

if (require.main === module) {
  usageNotice.cli().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = usageNotice;
