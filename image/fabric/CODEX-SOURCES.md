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
On Linux, building the wrapper requires the Rust version in the archived `rust-toolchain.toml`, a C toolchain, pkg-config, and libcap development files:

```sh
cd codex-source/codex-rs
cargo update --workspace
cargo build --locked --release -p codex-bwrap
```

The archived manifests use workspace version `0.154.0`, while the lockfile's local workspace entries use `0.0.0`.
The workspace-only update normalizes those local entries before the locked build; it does not update existing external dependency pins.
It can access the registry and Git sources when they are not already cached.

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
`codex-v8-source.tar.gz` and `codex-v8-LICENSE` retain V8 15.0.245.2's source and original license.
That version appears in both Code Mode binaries, and the archive checksum matches Codex's `MODULE.bazel` source pin.
The archive preserves V8's included third-party notices; Codex's patches are in its separate source archive.
`codex-icu-LICENSE`, `codex-libcxx-LICENSE`, `codex-libcxxabi-LICENSE`, and `codex-llvm-libc-LICENSE` retain the original notices from the revisions selected by Codex's V8 module patch and native build inputs.
Gitiles serves these files encoded; the build decodes them without changing their text.
`codex-rusty-v8-LICENSE` retains the MIT notice from the source revision recorded by the locked `v8` 150.4.0 crate.
The crate records a dirty working tree, so that revision does not establish an exact source match.
Remaining compiled dependencies and complete per-binary notice/source coverage still need reconciliation in [#13524](https://github.com/NVIDIA/NemoClaw/issues/13524).

## Additional MPL Sources

The `codex/` source directory also retains these original sources and their included MPL-2.0 notices:

- `codex-symphonia-source.tar.gz`: Symphonia at `980bf5830a90e069fd64641d9c38f067ab772a24`, matching the Rust sources and notices of all nine locked Symphonia 0.6.0 crates.
- `codex-nucleo-source.tar.gz`: Nucleo at `4253de9faabb4e5c6d81d946a5e35a90f87347ee`, including the locked `nucleo` 0.5.0 and `nucleo-matcher` 0.3.1 sources.
- `option-ext-source.crate`: the original `option-ext` 0.2.0 registry archive identified by the target-specific dependency trees.

Extract these gzip-compressed archives with `tar -xzf ARCHIVE` to inspect or modify their sources.
For a Cargo rebuild using modified sources, add entries for their extracted directories under `[patch.crates-io]` in the Codex workspace manifest; Nucleo uses `[patch."https://github.com/helix-editor/nucleo.git"]` instead.
Update the affected lock entries before building with `--locked` again.
The unmodified build continues to use the original source pins; these archives do not supply every transitive dependency or an offline build environment.
