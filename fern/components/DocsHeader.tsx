// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType } from "react";

type HeaderControl =
  | "Logo"
  | "ProductSwitcher"
  | "VersionSwitcher"
  | "Search"
  | "NavbarLinks"
  | "ThemeSwitch"
  | "HamburgerMenu";

// Keep menu styles with the header because the NVIDIA theme supplies the site stylesheets.
export default function DocsHeader({ Fern }: { Fern: Record<HeaderControl, ComponentType> }) {
  return (
    <div className="fern-header-content">
      <style>{`
        .fern-dropdown .fern-product-selector-radio-group {
          grid-template-columns: 1fr;
          gap: 0;
          min-width: 6rem;
        }
        .fern-dropdown:has(.fern-product-selector-radio-group) {
          min-width: 0;
          width: max-content;
          padding: 0.25rem;
        }
        .fern-product-selector-radio-group .fern-selection-item { padding: 0.375rem 0.625rem; }
        .fern-product-selector-radio-group .fern-selection-item-icon { display: none; }
        .fern-product-item-link[aria-checked="true"] .fern-selection-item-end-icon::after {
          content: "";
          display: block;
          width: 0.4rem;
          height: 0.65rem;
          border: solid currentColor;
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }
        .nvidia-preview-banner-enabled #fern-sidebar[data-viewport="mobile"] {
          top: calc(var(--header-height) + var(--nvidia-preview-banner-offset));
          bottom: 0;
          height: auto;
        }
      `}</style>
      <div className="mx-auto flex w-full max-w-page-width items-center gap-4">
        <div className="fern-header-logo-container">
          <Fern.Logo />
          <div className="hidden lg:flex fern-header-selectors">
            <Fern.ProductSwitcher />
            <Fern.VersionSwitcher />
          </div>
        </div>
        <div className="w-full max-w-[640px]">
          <Fern.Search />
        </div>
        <nav
          aria-label="Navigation"
          className="fern-header-navbar-links ml-auto hidden items-center gap-2 lg:flex"
        >
          <Fern.NavbarLinks />
          <Fern.ThemeSwitch />
        </nav>
        <div className="fern-header-mobile-menu-button lg:hidden">
          <Fern.HamburgerMenu />
        </div>
      </div>
    </div>
  );
}
