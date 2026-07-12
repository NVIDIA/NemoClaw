/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Badge links for GitHub, License, project status, Discord, etc.
 * Uses a flex wrapper to display badges horizontally and hides Fern's
 * external-link icon that otherwise stacks under each badge image.
 * Requires the `.badge-links` CSS rule from main.css.
 */
declare const React: unknown;

export type BadgeItem = {
  href: string;
  src: string;
  alt: string;
};

export function BadgeLinks({ badges = [] }: { badges?: BadgeItem[] }) {
  if (badges.length === 0) {
    return null;
  }
  return (
    <div
      className="badge-links"
      style={{
        alignItems: "center",
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        lineHeight: 0,
        margin: "0.25rem 0 0.75rem",
      }}
    >
      {badges.map((b) => (
        <a
          key={b.href}
          href={b.href}
          target="_blank"
          rel="noreferrer"
          style={{
            alignItems: "center",
            display: "inline-flex",
            width: "auto",
          }}
        >
          <img
            src={b.src}
            alt={b.alt}
            style={{
              display: "block",
              margin: 0,
            }}
          />
        </a>
      ))}
    </div>
  );
}
