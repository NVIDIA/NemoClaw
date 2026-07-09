// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ConfigObject = import("../security/credential-filter").ConfigObject;
type ConfigValue = import("../security/credential-filter").ConfigValue;

const {
  isConfigObject,
  isConfigValue,
}: typeof import("../security/credential-filter") = require("../security/credential-filter");

/** Parse raw agent configuration according to its manifest-declared format. */
export function parseConfig(raw: string, format: string): ConfigObject {
  let parsed: ConfigValue | object;
  if (format === "yaml") {
    parsed = require("yaml").parse(raw);
  } else if (format === "toml") {
    parsed = require("smol-toml").parse(raw);
  } else {
    parsed = JSON.parse(raw);
  }
  if (!isConfigObject(parsed) || !isConfigValue(parsed)) {
    throw new Error("Config is not a JSON-like object.");
  }
  return parsed;
}

/** Serialize mutable agent configuration without corrupting TOML inputs. */
export function serializeConfig(config: ConfigObject, format: string): string {
  if (format === "yaml") {
    return require("yaml").stringify(config);
  }
  if (format === "toml") {
    throw new Error("config set is not supported for TOML-format agents.");
  }
  return JSON.stringify(config, null, 2);
}
