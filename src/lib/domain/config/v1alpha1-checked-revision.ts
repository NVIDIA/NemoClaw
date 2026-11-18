// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The v1 revision the export is checked against (the compatibility tests parse with its SDK). v1 supplies no per-harness defaults, so the
 * exporter keeps no table of them: it passes observed v0 values through and reports what v1
 * cannot hold.
 */
export const V1ALPHA1_CHECKED_REVISION = "d1d0c87e535f9c757f47dde6ee157e9859dd91fd" as const;
