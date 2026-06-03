/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

declare const React: unknown;

export function CommandTerminal({ command }: { command: string }) {
  return (
    <div
      style={{
        background: "#1a1a2e",
        borderRadius: "8px",
        boxShadow: "0 4px 16px rgb(0 0 0 / 25%)",
        fontFamily:
          '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: "0.875rem",
        lineHeight: 1.8,
        margin: "1.5rem 0",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "#252545",
          display: "flex",
          gap: "7px",
          padding: "10px 14px",
        }}
      >
        <span style={dotStyle("#ff5f56")} />
        <span style={dotStyle("#ffbd2e")} />
        <span style={dotStyle("#27c93f")} />
      </div>
      <div
        style={{
          color: "#d4d4d8",
          overflowX: "auto",
          padding: "16px 20px",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "#76B900", userSelect: "none" }}>$ </span>
        <span>{command}</span>
      </div>
    </div>
  );
}

function dotStyle(background: string) {
  return {
    background,
    borderRadius: "50%",
    display: "inline-block",
    height: "12px",
    width: "12px",
  };
}
