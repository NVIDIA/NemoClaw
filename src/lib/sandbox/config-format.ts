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
    const YAML = require("yaml") as {
      parse: (text: string) => ConfigValue | object;
    };
    try {
      parsed = YAML.parse(raw);
    } catch {
      throw new Error("Invalid YAML configuration syntax.");
    }
  } else if (format === "toml") {
    const TOML = require("smol-toml") as {
      parse: (text: string) => ConfigValue | object;
    };
    try {
      parsed = TOML.parse(raw);
    } catch {
      throw new Error("Invalid TOML configuration syntax.");
    }
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON configuration syntax.");
    }
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
