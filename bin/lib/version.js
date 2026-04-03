// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Thin re-export shim — the implementation lives in src/lib/version.ts,
// compiled to dist/lib/version.js.

module.exports = require("../../dist/lib/version");
