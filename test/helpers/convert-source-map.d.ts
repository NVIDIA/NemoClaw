// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

declare module "convert-source-map" {
  interface SourceMapConverter {
    toObject(): unknown;
  }

  interface ConvertSourceMapApi {
    fromMapFileSource(
      source: string,
      read: (filename: string) => string,
    ): SourceMapConverter | null;
    fromSource(source: string): SourceMapConverter | null;
  }

  const convertSourceMap: ConvertSourceMapApi;
  export default convertSourceMap;
}
