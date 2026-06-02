/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves OpenClaw vs Hermes user-guide variant from injected route data.
 * Prefer passing `variant` or `pathname` from the page or route that renders the
 * component so SSR output does not depend on browser-only globals. The window
 * fallback preserves the current client-side behavior for unwrapped pages.
 */
declare const React: unknown;

export type GuideVariant = "openclaw" | "hermes";
export type GuideVariantSource =
  | GuideVariant
  | string
  | {
      variant?: GuideVariant | null;
      activeVariant?: GuideVariant | null;
      pathname?: string | null;
    }
  | null
  | undefined;

type GuideContextProps = {
  variant?: GuideVariant | null;
  activeVariant?: GuideVariant | null;
  pathname?: string | null;
};

const GUIDE_PATH = "/user-guide/";
const HERMES_PATH = `${GUIDE_PATH}hermes`;
const OPENCLAW_PATH = `${GUIDE_PATH}openclaw`;

export function getGuideVariant(source?: GuideVariantSource): GuideVariant {
  return resolveGuideVariant(source) ?? resolveGuideVariant(readWindowPathname()) ?? "openclaw";
}

export function guideBasePath(source?: GuideVariantSource): string {
  const pathname = resolveGuidePathname(source) ?? readWindowPathname();
  if (!pathname) return "";
  const guideIndex = pathname.indexOf(GUIDE_PATH);
  return guideIndex === -1 ? "" : pathname.slice(0, guideIndex);
}

/** Full site path for the active guide variant (includes /user-guide/{variant}). */
export function guidePath(suffix: string, source?: GuideVariantSource): string {
  const normalized = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${guideBasePath(source)}${GUIDE_PATH}${getGuideVariant(source)}${normalized}`;
}

export function AgentCli(props: GuideContextProps = {}) {
  return <code>{getGuideVariant(props) === "hermes" ? "nemohermes" : "nemoclaw"}</code>;
}

export function AgentProductName(props: GuideContextProps = {}) {
  return <>{getGuideVariant(props) === "hermes" ? "NemoHermes" : "NemoClaw"}</>;
}

export function AgentOnly({
  variant,
  activeVariant,
  pathname,
  children,
}: {
  variant: GuideVariant;
  activeVariant?: GuideVariant | null;
  pathname?: string | null;
  children: unknown;
}) {
  if (getGuideVariant({ activeVariant, pathname }) !== variant) {
    return null;
  }
  return <>{children}</>;
}

export function GuideLink({
  href,
  variant,
  activeVariant,
  pathname,
  children,
}: {
  href: string;
  variant?: GuideVariant | null;
  activeVariant?: GuideVariant | null;
  pathname?: string | null;
  children: unknown;
}) {
  const resolved =
    href.startsWith("http://") || href.startsWith("https://")
      ? href
      : guidePath(href, { variant, activeVariant, pathname });
  return <a href={resolved}>{children}</a>;
}

function resolveGuideVariant(source?: GuideVariantSource): GuideVariant | null {
  if (!source) return null;
  if (source === "openclaw" || source === "hermes") return source;
  if (typeof source === "string") return resolveGuideVariantFromPathname(source);
  return (
    source.activeVariant ??
    source.variant ??
    resolveGuideVariantFromPathname(source.pathname ?? null)
  );
}

function resolveGuidePathname(source?: GuideVariantSource): string | null {
  if (!source || source === "openclaw" || source === "hermes") return null;
  if (typeof source === "string") return source;
  return source.pathname ?? null;
}

function resolveGuideVariantFromPathname(pathname: string | null): GuideVariant | null {
  if (!pathname) return null;
  if (pathname.includes(HERMES_PATH)) return "hermes";
  if (pathname.includes(OPENCLAW_PATH)) return "openclaw";
  return null;
}

function readWindowPathname(): string | null {
  return typeof window === "undefined" ? null : window.location.pathname;
}
