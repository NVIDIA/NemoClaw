// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Severity levels shared by advisory producers and presenters. */
export type AdvisorySeverity = "fatal" | "blocking" | "warning" | "info" | "hint";

/** Lifecycle phases in which advisory checks can run. */
export type AdvisoryPhase =
  | "preflight.host"
  | "preflight.network"
  | "onboard.gateway"
  | "onboard.sandbox"
  | "onboard.credentials"
  | "onboard.inference"
  | "runtime.rebuild"
  | "runtime.destroy"
  | "runtime.shields";

/** Remediation interaction required from an operator. */
export type AdvisoryKind = "manual" | "sudo" | "info";

/** A structured, stable diagnostic produced by an advisory check. */
export interface Advisory {
  id: string;
  severity: AdvisorySeverity;
  phase: AdvisoryPhase;
  title: string;
  reason: string;
  commands?: readonly string[];
  docsUrl?: string;
  resumeSafe: boolean;
  kind?: AdvisoryKind;
}

/** A pure advisory check and the metadata that controls its execution. */
export interface AdvisoryCheck<Context> {
  id: string;
  phase: AdvisoryPhase;
  severity: AdvisorySeverity;
  resumeSafe: boolean;
  skipIf?: (context: Context) => boolean;
  check: (context: Context) => Advisory | null;
}
