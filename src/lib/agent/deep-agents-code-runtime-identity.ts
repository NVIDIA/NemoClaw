// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// @ts-ignore CommonJS compilation erases the attribute; native Node source loading requires it.
import identity from "./deep-agents-code-runtime-identity.json" with { type: "json" };

/** Numeric sandbox identity shared by image construction and cleanup. */
export const DEEP_AGENTS_CODE_RUNTIME_IDENTITY = Object.freeze(identity);
export const DEEP_AGENTS_CODE_SANDBOX_USER = `${DEEP_AGENTS_CODE_RUNTIME_IDENTITY.uid}:${DEEP_AGENTS_CODE_RUNTIME_IDENTITY.gid}`;
