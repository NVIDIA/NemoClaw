#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NemoHermes — alias for NemoClaw with the Hermes agent pre-selected.
process.env.NEMOCLAW_AGENT = "hermes";
process.env.NEMOCLAW_INVOKED_AS = "nemohermes";
module.exports = require("../dist/nemoclaw");
