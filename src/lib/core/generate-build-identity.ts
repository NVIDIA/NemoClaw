// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createCuaBuildIdentityStamp, CUA_BUILD_IDENTITY_FILE } from "../cua/build-identity";
import { resolveSourceBuildIdentity } from "./version";

const root = join(__dirname, "..", "..", "..");
const outputPath = join(root, "dist", "build-identity.json");
const identity = resolveSourceBuildIdentity({ rootDir: root });
const cuaIdentity = createCuaBuildIdentityStamp(root, identity.sourceRevision);

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(identity, null, 2)}\n`);
writeFileSync(
  join(root, "dist", CUA_BUILD_IDENTITY_FILE),
  `${JSON.stringify(cuaIdentity, null, 2)}\n`,
);
