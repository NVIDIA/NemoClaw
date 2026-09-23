// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use ratatui::{
    backend::{Backend, ClearType, CrosstermBackend, IntoCrossterm, WindowSize},
    buffer::Cell,
    crossterm::{
        cursor::{MoveDown, MoveToColumn, MoveUp},
        queue,
        style::{Attribute, Print, SetAttribute, SetStyle},
    },
    layout::{Position, Size},
    text::Span,
};
use std::io;

/// Ratatui uses virtual rows ending at the current output line. Relative cursor movement
/// keeps inline output beside the shell prompt without querying or consuming terminal input.
/// Appended lines advance that origin naturally, including when the physical screen scrolls.
pub(super) struct OutputBackend {
    inner: CrosstermBackend<io::Stderr>,
    cursor: Position,
    size: Size,
}
impl OutputBackend {
    pub(super) fn new() -> io::Result<Self> {
        let mut inner = CrosstermBackend::new(io::stderr());
        let size = stderr_size()?;
        let cursor = Position::new(0, size.height.saturating_sub(1));
        if size.width == 0 || size.height == 0 {
            return Err(io::Error::other("terminal has no drawable area"));
        }
        queue!(inner, MoveToColumn(0))?;
        inner.flush()?;
        Ok(Self {
            inner,
            cursor,
            size,
        })
    }
    pub(super) fn current_size(&self) -> io::Result<Size> {
        stderr_size()
    }
}
impl Backend for OutputBackend {
    type Error = io::Error;
    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let mut style = None;
        let mut covered = None;
        for (x, y, cell) in content {
            // insert_before supplies the whole buffer, including wide-glyph continuation cells.
            if covered.is_some_and(|(row, end)| row == y && x < end) {
                continue;
            }
            if self.cursor != Position::new(x, y) {
                self.set_cursor_position((x, y))?;
            }
            if style != Some(cell.style()) {
                queue!(
                    self.inner,
                    SetAttribute(Attribute::Reset),
                    SetStyle(cell.style().into_crossterm())
                )?;
                style = Some(cell.style());
            }
            queue!(self.inner, Print(cell.symbol()))?;
            self.cursor =
                Position::new(x.saturating_add(Span::raw(cell.symbol()).width() as u16), y);
            covered = Some((y, self.cursor.x));
        }
        queue!(self.inner, SetAttribute(Attribute::Reset))?;
        Ok(())
    }
    fn append_lines(&mut self, n: u16) -> io::Result<()> {
        self.inner.append_lines(n)?;
        self.cursor.y = self
            .cursor
            .y
            .saturating_add(n)
            .min(self.size()?.height.saturating_sub(1));
        Ok(())
    }
    fn hide_cursor(&mut self) -> io::Result<()> {
        self.inner.hide_cursor()
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        self.inner.show_cursor()
    }
    fn get_cursor_position(&mut self) -> io::Result<Position> {
        Ok(self.cursor)
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        let next = position.into();
        if next.y < self.cursor.y {
            queue!(self.inner, MoveUp(self.cursor.y - next.y))?;
        } else if next.y > self.cursor.y {
            queue!(self.inner, MoveDown(next.y - self.cursor.y))?;
        }
        queue!(self.inner, MoveToColumn(next.x))?;
        self.cursor = next;
        Ok(())
    }
    fn clear(&mut self) -> io::Result<()> {
        self.inner.clear()
    }
    fn clear_region(&mut self, kind: ClearType) -> io::Result<()> {
        self.inner.clear_region(kind)
    }
    fn size(&self) -> io::Result<Size> {
        // A frame uses one size snapshot. The owner reanchors before rendering a resize.
        Ok(self.size)
    }
    fn window_size(&mut self) -> io::Result<WindowSize> {
        self.inner.window_size()
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn stderr_size() -> io::Result<Size> {
    terminal_size::terminal_size_of(io::stderr())
        .map(
            |(terminal_size::Width(width), terminal_size::Height(height))| Size::new(width, height),
        )
        .ok_or_else(|| io::Error::other("cannot read stderr terminal dimensions"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs::File,
        process::{Command, Stdio},
    };

    #[test]
    fn stderr_dimensions_are_independent_of_stdout_and_the_controlling_terminal() {
        const CHILD: &str = "NEMOCLAW_TEST_STDERR_DIMENSIONS";
        if std::env::var_os(CHILD).is_some() {
            let backend = OutputBackend::new().unwrap();
            assert_eq!(backend.size().unwrap(), Size::new(19, 7));
            assert_eq!(backend.current_size().unwrap(), Size::new(19, 7));
            return;
        }
        let pty = nix::pty::openpty(
            Some(&nix::pty::Winsize {
                ws_row: 7,
                ws_col: 19,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "progress::backend::tests::stderr_dimensions_are_independent_of_stdout_and_the_controlling_terminal", "--nocapture"])
            .env(CHILD, "1")
            .stdin(Stdio::null()).stdout(Stdio::piped())
            .stderr(Stdio::from(File::from(pty.slave)))
            .output().unwrap();
        assert!(
            child.status.success(),
            "child test failed: {}",
            String::from_utf8_lossy(&child.stdout)
        );
        assert!(
            !child.stdout.contains(&0x1b),
            "terminal controls leaked onto stdout"
        );
    }
}
