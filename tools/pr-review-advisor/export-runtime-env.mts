#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { ADVISOR_PI_IMAGE } from "./runtime-constants.mts";

const output = process.env.GITHUB_ENV;
if (!output) throw new Error("GITHUB_ENV is required");
fs.appendFileSync(output, `PI_IMAGE=${ADVISOR_PI_IMAGE}\n`, { encoding: "utf8" });
