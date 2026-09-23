// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::style::{Palette, Tone};
use std::{
    collections::hash_map::RandomState,
    hash::BuildHasher,
    io::{self, Write},
};

/// A fixed startup image needs no image decoder, terminal query, or redraw state.
/// Unknown terminals and multiplexers keep the text wordmark.
pub(super) fn write_brand(output: &mut impl Write, palette: Palette) -> io::Result<bool> {
    let term = std::env::var("TERM").unwrap_or_default();
    let supported = (term == "xterm-kitty" && nonempty("KITTY_WINDOW_ID"))
        || (term == "xterm-ghostty"
            && std::env::var("TERM_PROGRAM").is_ok_and(|value| value == "ghostty"));
    let room = terminal_size::terminal_size_of(io::stderr())
        .is_some_and(|(width, height)| width.0 >= 26 && height.0 >= 6);
    if !palette.enabled
        || !supported
        || ["TMUX", "STY", "ZELLIJ"].into_iter().any(nonempty)
        || !room
    {
        return Ok(false);
    }

    // q=2 suppresses replies. Unicode placeholders anchor the image to text during
    // scrolling AND reflow; ordinary image placements drift when a window resizes.
    // Random 24-bit IDs fit in a foreground color and reduce collisions with other apps.
    // https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
    let id = (RandomState::new().hash_one(std::process::id()) as u32 & 0xff_ffff).max(1);
    let png = include_str!("../../assets/nvidia-eye.png.base64").trim();
    write!(
        output,
        "\r\x1b_Ga=T,f=100,q=2,U=1,i={id},c=6,r=2;{png}\x1b\\",
    )?;
    for (row, label) in [
        (
            '\u{305}',
            format!("  {} / NemoClaw", palette.paint("NVIDIA", Tone::Accent)),
        ),
        ('\u{30d}', String::new()),
    ] {
        // The first cell supplies row/column zero; the next five inherit the row
        // and increment the column, as specified by the placeholder protocol.
        write!(
            output,
            "\x1b[38;2;{};{};{}m\u{10eeee}{row}\u{305}{}\x1b[39m{label}\r\n",
            id >> 16,
            (id >> 8) & 255,
            id & 255,
            "\u{10eeee}".repeat(5),
        )?;
    }
    write!(output, "\r\n")?;
    output.flush()?;
    Ok(true)
}

fn nonempty(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}
