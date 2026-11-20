<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Codex Sources and Notices

The Codex image retains `codex-source.tar.gz` under `/opt/nemoclaw/source/`.
It contains the unmodified repository at `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`, the source revision of Codex 0.154.0.
Download URLs and SHA-256 values are pinned in `versions.json`.

Copy the archive to a working directory and extract it:

```sh
mkdir codex-source
tar -xzf codex-source.tar.gz -C codex-source --strip-components=1
```

The archive includes `codex-rs/vendor/bubblewrap`, Codex's Rust wrapper in `codex-rs/bwrap`, the Cargo lockfile, build scripts, and patches.
`codex-bubblewrap-COPYING` separately retains Bubblewrap's LGPL-2.0-or-later license text.
Its original copyright notices remain in the archived C sources.
On Linux, building the wrapper requires the archived Rust toolchain, a C toolchain, pkg-config, and libcap development files:

```sh
cd codex-source/codex-rs
cargo build --locked --release -p codex-bwrap
```

`codex-libcap-source.tar.xz` and `codex-libcap-License` retain libcap 2.75's source and license, matching the version and checksum in Codex's `.github/scripts/install-musl-build-tools.sh`.
That archived script records its musl build flags and pkg-config configuration.
Cargo can download dependencies; they are not vendored in this archive.
These inputs do not establish complete transitive-source or relinking delivery for the shipped executable.

`codex-rg-LICENSE-MIT` retains the MIT choice for the bundled ripgrep 15.2.0.
`codex-zsh-LICENCE` retains Zsh's license from `77045ef899e53b9598bebc5a41db93a548a40ca6`, the revision named by the bundled shell's patch level.
Codex's shell modification patch and build script are in its source archive.
The image copies only the Zsh executable, not the upstream shell-function collection.

`codex-rust-COPYRIGHT-library.html` retains the standard-library notices for Rust 1.95.0, used by Codex, Code Mode, and Bubblewrap.
`codex-rg-rust-COPYRIGHT-library.html` retains the corresponding notices for ripgrep: Rust 1.97.0 on ARM64, or nightly `da80ed0708a09dc096c184345d6eb42cbcd50a1e` on AMD64.
These versions are identified by compiler source paths embedded in the binaries.
Other compiled dependencies, including V8/ICU and native link inputs, remain part of [#13524](https://github.com/NVIDIA/NemoClaw/issues/13524).
