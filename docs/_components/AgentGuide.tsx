/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves OpenClaw vs Hermes user-guide variant from the URL path.
 * Use for CLI names, quickstart links, and explore cards on shared MDX pages.
 */
declare const React: unknown;

export type GuideVariant = "openclaw" | "hermes";

const GUIDE_PATH = "/user-guide/";
const HERMES_PATH = `${GUIDE_PATH}hermes`;

export function getGuideVariant(): GuideVariant {
  if (typeof window !== "undefined" && window.location.pathname.includes(HERMES_PATH)) {
    return "hermes";
  }
  return "openclaw";
}

function guideBasePath(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const guideIndex = window.location.pathname.indexOf(GUIDE_PATH);
  return guideIndex === -1 ? "" : window.location.pathname.slice(0, guideIndex);
}

/** Full site path for the active guide variant (includes /user-guide/{variant}). */
export function guidePath(suffix: string): string {
  const normalized = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${guideBasePath()}${GUIDE_PATH}${getGuideVariant()}${normalized}`;
}

export function AgentCli() {
  return <code>{getGuideVariant() === "hermes" ? "nemohermes" : "nemoclaw"}</code>;
}

export function AgentProductName() {
  return <>{getGuideVariant() === "hermes" ? "NemoHermes" : "NemoClaw"}</>;
}

export function AgentOnly({
  variant,
  children,
}: {
  variant: GuideVariant;
  children: unknown;
}) {
  if (getGuideVariant() !== variant) {
    return null;
  }
  return <>{children}</>;
}

export function GuideLink({
  href,
  children,
}: {
  href: string;
  children: unknown;
}) {
  const resolved =
    href.startsWith("http://") || href.startsWith("https://") ? href : guidePath(href);
  return <a href={resolved}>{children}</a>;
}
