// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Thin re-export shim — the implementation lives in src/lib/credentials.ts,
// compiled to dist/lib/credentials.js.

const mod = require("../../dist/lib/credentials");

const exports_ = { ...mod };

Object.defineProperty(exports_, "CREDS_DIR", { get: mod.getCredsDir, enumerable: true });
Object.defineProperty(exports_, "CREDS_FILE", { get: mod.getCredsFile, enumerable: true });

module.exports = exports_;
