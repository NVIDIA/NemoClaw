// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: nemoclaw/src/shared/banner-boundary.cts
// This package entry wrapper keeps the ./banner.js import path stable for
// nemoclaw/src/index.ts while the renderer lives in the shared .cts boundary.
import { renderBox as canonicalRenderBox } from "./shared/banner-boundary.cjs";

export type { BannerLine, RenderBoxOptions } from "./shared/banner-boundary.cjs";

export const renderBox = canonicalRenderBox;
