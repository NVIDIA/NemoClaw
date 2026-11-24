<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# macOS Installer Resources

[`macos-installer.rs`](../macos-installer.rs) builds the macOS installer from a `darwin_arm64` bundle and compiles these files into itself:

- `welcome.html` and `conclusion.html`, the first and last pages, styled by `style.css` for Installer's light and dark appearance. The tool replaces each `{{NAME}}` placeholder; an unknown one fails the build.
- `background.svg` and `background-darkAqua.svg`, the window's artwork for the light and dark appearance, and their renderings at 1x (620 × 418) and 2x (1240 × 836).
  The tool joins each pair into one HiDPI TIFF with `tiffutil`, which Installer draws from the window's bottom-left corner without scaling.

The license page is generated from the bundle's `LICENSE` and its `licenses` directory.

The artwork and the pages' colors are placeholders pending NVIDIA brand and trademark review; they use no NVIDIA logo.

## Regenerating the Artwork

After editing an SVG, render both sizes with [resvg](https://github.com/linebender/resvg) 0.50.0, installed with `cargo install resvg@0.50.0 --locked`:

```sh
cd tools/release/macos-installer
for name in background background-darkAqua; do
  resvg --width 620 "$name.svg" "$name.png"
  resvg --width 1240 "$name.svg" "$name@2x.png"
done
```

Commit the SVGs and the PNGs together.
