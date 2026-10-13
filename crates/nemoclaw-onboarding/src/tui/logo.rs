// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use ratatui::{
    style::{Color, Style},
    text::Span,
};
use std::{
    collections::hash_map::RandomState,
    hash::BuildHasher,
    io::{self, IsTerminal, Write},
};

const MIN_SCREEN_WIDTH: u16 = 88;
const PLACEHOLDER: char = '\u{10eeee}';

#[derive(Clone, Copy)]
pub(super) struct BrandImage {
    id: u32,
}

impl BrandImage {
    pub(super) fn detect(screen_width: u16) -> Option<Self> {
        let term = std::env::var("TERM").unwrap_or_default();
        let supported = (term == "xterm-kitty" && nonempty("KITTY_WINDOW_ID"))
            || (term == "xterm-ghostty"
                && std::env::var("TERM_PROGRAM").is_ok_and(|value| value == "ghostty"));
        if !supported
            || !io::stderr().is_terminal()
            || std::env::var_os("NO_COLOR").is_some()
            || ["TMUX", "STY", "ZELLIJ"].into_iter().any(nonempty)
            || screen_width < MIN_SCREEN_WIDTH
        {
            return None;
        }
        let id = (RandomState::new().hash_one(std::process::id()) as u32 & 0xff_ffff).max(1);
        Some(Self { id })
    }

    #[cfg(test)]
    pub(super) const fn from_id(id: u32) -> Self {
        Self { id }
    }

    pub(super) fn transmit(self, output: &mut impl Write) -> io::Result<()> {
        let png =
            include_str!("../../../../crates/nemoclaw-cli/assets/nvidia-eye.png.base64").trim();
        write!(
            output,
            "\x1b_Ga=T,f=100,q=2,U=1,i={},c=6,r=2;{png}\x1b\\",
            self.id
        )?;
        output.flush()
    }

    pub(super) fn delete(self, output: &mut impl Write) -> io::Result<()> {
        write!(output, "\x1b_Ga=d,d=I,q=2,i={}\x1b\\", self.id)?;
        output.flush()
    }

    pub(super) fn placeholder(self, row: usize) -> Span<'static> {
        let row_mark = if row == 0 { '\u{305}' } else { '\u{30d}' };
        let cells = format!(
            "{PLACEHOLDER}{row_mark}\u{305}{}",
            PLACEHOLDER.to_string().repeat(5)
        );
        Span::styled(
            cells,
            Style::new().fg(Color::Rgb(
                (self.id >> 16) as u8,
                ((self.id >> 8) & 255) as u8,
                (self.id & 255) as u8,
            )),
        )
    }
}

fn nonempty(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::BrandImage;

    #[test]
    fn protocol_is_quiet_reflowable_and_deletes_only_its_image() {
        let brand = BrandImage::from_id(0x12_34_56);
        let mut output = Vec::new();
        brand.transmit(&mut output).unwrap();
        brand.delete(&mut output).unwrap();
        let output = String::from_utf8(output).unwrap();

        assert!(output.contains("a=T,f=100,q=2,U=1,i=1193046,c=6,r=2"));
        assert!(output.contains("a=d,d=I,q=2,i=1193046"));
        assert!(!output.contains("\x1b[6n"), "must not query the cursor");
    }
}
