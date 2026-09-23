// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: nemoclaw/src/shared/banner-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// module is compiled (mirrors src/lib/adapters/openshell/policy-boundary.ts). Keep this file
// implementation-free. It keeps the ../cli/banner import path stable for
// src/lib/tunnel/services.ts.
import { renderBox as canonicalRenderBox } from "../../../nemoclaw/dist/shared/banner-boundary.cjs";

export type {
  BannerLine,
  RenderBoxOptions,
} from "../../../nemoclaw/dist/shared/banner-boundary.cjs";

export const renderBox = canonicalRenderBox;
