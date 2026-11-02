<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pi Dependency Review

This file records the reviewed dependency baseline for the Pi sandbox base image.
Update it whenever `agents/pi/pi-runtime/package-lock.json` changes.

- Package: `@earendil-works/pi-coding-agent@0.84.1`
- npm integrity: `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==`
- npm SHA-1: `e098cada629fdeeb9df6e77c6d480d43e1b2c553`
- Lockfile: `agents/pi/pi-runtime/package-lock.json`
- Lockfile SHA-256: `3987ef6aa03d92708c947d2c24ec44cf2c10317e5f393e38b1ad7f1aa9769f56`
- Locked packages: 144
- Audit command: `npm --prefix agents/pi/pi-runtime audit --registry=https://registry.yarnpkg.com --omit=dev`
- Audit date: November 2, 2026
- Audit result: 5 affected packages (2 high, 3 moderate); no Undici advisory remains.
  The remaining brace-expansion, Zod, glob, and minimatch findings (including their Pi dependency effect) also occur on main at `97c8fb760565053bb8399eb8994bfb1dd464bd12` and are outside the supplied vulnerability list.
- Historical audit: August 14, 2026 reported `found 0 vulnerabilities` for the earlier lockfile.
- Registry metadata independently queried from npm: August 14, 2026

The package and integrity values match the accepted decision record for the Pi 0.84.1 candidate.
The image build asserts the version against `package.json` and the integrity value against the lockfile before installing, so an edited pin fails the build instead of shipping.

The lockfile records committed SHA-512 integrity values for all 144 resolved tarballs.
The base image installs the graph with `npm ci --omit=dev --ignore-scripts`.
npm verifies each downloaded tarball, and the build does not run install lifecycle scripts.
The published tarball includes `npm-shrinkwrap.json`, which fixes its transitive resolution.
The upstream shrinkwrap omitted integrity for six nested `@earendil-works` archives.
The NemoClaw lockfile supplies the registry-published SHA-512 values.
A reviewer independently confirmed those values against the downloaded tarball bytes on August 14, 2026.
The install is pinned to one exact version: a later Pi release requires a new dependency review, new integrity values, and new image digests.

The base image, the final image, and the startup entrypoint each set `PI_OFFLINE=1` and `PI_TELEMETRY=0`.
NemoClaw does not check what the Pi runtime does with those values; the deny-by-default network policy in `agents/pi/policy-additions.yaml` is the enforced control, and it allows only the managed inference route.
The installed tree is owned by root and carries no group or other write bits, so the sandbox user cannot replace the runtime it executes.

## November 2026 Undici remediation

The November 2 review found `undici@8.9.0` in Pi's nested shrinkwrap.
The runtime manifest overrides the affected 8.x range with `8.12.2`, fixing CVE-2026-87018 and CVE-2026-87029.
The lock was regenerated with npm 12.0.2, which the image already uses and which ignores upstream npm shrinkwraps.
A clean install with Node.js 24.22.1 and npm 12.0.2 resolves `undici@8.12.2` from Pi's package directory.
The Pi version and archive integrity remain unchanged.
Remove the override when the reviewed Pi graph resolves a patched Undici without it.

The final image scan also found npm 12.0.2’s private `undici@6.27.0`, affected by CVE-2026-87018.
All managed base and final images now invoke the existing registry- and SRI-verified `patch-bundled-npm-undici.mts` helper after the npm upgrade to install `6.29.1`.
Final images repeat the check so older bases cannot restore the affected package.
