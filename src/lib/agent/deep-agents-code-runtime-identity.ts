// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import identity from "./deep-agents-code-runtime-identity.json";

/** Numeric sandbox identity shared by image construction and cleanup. */
export const DEEP_AGENTS_CODE_SANDBOX_USER = `${identity.uid}:${identity.gid}`;
