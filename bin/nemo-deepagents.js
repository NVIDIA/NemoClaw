#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Nemo Deep Agents — alias for NemoClaw with LangChain Deep Agents Code pre-selected.
process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
process.env.NEMOCLAW_INVOKED_AS = "nemo-deepagents";
module.exports = require("../dist/nemoclaw");
