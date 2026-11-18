// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Supply helper executables and remove interpreter and loader hooks in privileged commands. */
export const SANITIZED_PRIVILEGED_ENV = [
  // OpenShell clears the image environment; privileged engine exec needs its own search path.
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "BASH_ENV=",
  "ENV=",
  "GCONV_PATH=",
  "GLIBC_TUNABLES=",
  "LD_AUDIT=",
  "LD_LIBRARY_PATH=",
  "LD_PRELOAD=",
  "LOCPATH=",
  "NODE_OPTIONS=",
  "PERL5OPT=",
  "PYTHONHOME=",
  "PYTHONINSPECT=",
  "PYTHONNOUSERSITE=1",
  "PYTHONPATH=",
  "PYTHONSTARTUP=",
  "PYTHONUSERBASE=",
  "RUBYOPT=",
] as const;
