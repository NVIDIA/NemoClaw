<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributor Lint Dependency Review

## `eslint-plugin-sonarjs` 4.2.0

| Property | Reviewed value |
| --- | --- |
| Consumer | `oxlint.config.ts` cognitive-complexity rules |
| Dependency class | Root development dependency |
| Registry artifact | `eslint-plugin-sonarjs-4.2.0.tgz` |
| Integrity | `sha512-bqADfuNtTL7VK6RU29eoiFTtaaBKIpVPuX3bOl+rBpWSBa0zIBVZlqZNZQjfP6s4iXkAJokv5IsD8OsACkwApg==` |
| Declared license | `LGPL-3.0-only` |
| Lifecycle scripts | None declared |

NemoClaw executes this package only during contributor and CI lint checks. The package is not a
production dependency. The `files` array in the root `package.json` does not include `tools/`, and
`npm pack --dry-run --json --ignore-scripts` does not include the SonarJS package code.
The locked npm cache seed generated from `nemoclaw/package-lock.json` does not include SonarJS.

Review this dependency again if any of these facts changes:

- Package version.
- Declared license.
- Dependency class.
- Registry artifact contents.
- Inclusion in a NemoClaw image or published package.
- Execution outside contributor and CI lint checks.
