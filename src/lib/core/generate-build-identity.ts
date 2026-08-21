// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveSourceBuildIdentity } from "./version";

const root = join(__dirname, "..", "..", "..");
const outputPath = join(root, "dist", "build-identity.json");
const identity = resolveSourceBuildIdentity({ rootDir: root });

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(identity, null, 2)}\n`);
