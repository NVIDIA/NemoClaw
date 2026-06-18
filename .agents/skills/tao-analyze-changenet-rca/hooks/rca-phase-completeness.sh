#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Deep verification that every RCA phase has substantive content, not just headings
# Checks section existence, minimum content depth, required analytical elements per section
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then
  warnings=""

  # --- Use Python for robust section-by-section validation ---
  section_warnings=$(python3 - "$CLAUDE_FILE_PATH" << 'PYEOF'
import sys, re

report_path = sys.argv[1]
with open(report_path) as f:
    report = f.read()

# Define checks: (section_heading_pattern, min_table_rows, [required_keywords])
checks = [
    ("Verdict", 1, ["tier", "root cause", "score gap"]),
    ("Score Analysis", 5, ["threshold", "recall", "FAR", "per-defect", "drop"]),
    ("Visual Evidence", 15, ["golden", "failure mode", "false positive", "detect"]),
    ("Cross-Dimensional", 5, ["comp_type", "board", "training", "component"]),
    ("Data Issues", 3, ["coverage", "ratio", "validation", "gap"]),
    ("Training Config", 5, ["cls_weight", "sampler", "learning rate", "over-emphasis"]),
    ("Exploratory Findings", 5, ["random", "anomal", "integrity", "distribution"]),
    ("Counterfactual", 3, ["what-if", "simulation", "FAR", "fix"]),
    ("Recommended Fixes", 3, ["CRITICAL", "effort", "impact"]),
]

warnings = []

for heading, min_rows, keywords in checks:
    # Extract section content between this heading and next ##
    pattern = rf'## .*?{re.escape(heading)}(.*?)(?=\n## |\Z)'
    m = re.search(pattern, report, re.DOTALL | re.IGNORECASE)
    if not m:
        warnings.append(f"MISSING SECTION: '{heading}' not found at all.")
        continue

    content = m.group(1)

    # Count table data rows (exclude separator rows with ---)
    rows = len([l for l in content.splitlines() if l.strip().startswith('|') and '---' not in l])
    if rows < min_rows:
        warnings.append(f"SHALLOW: '{heading}' has only {rows} table rows (need {min_rows}+). Add per-sample data tables.")

    # Word count
    words = len(content.split())
    if words < 100:
        warnings.append(f"THIN: '{heading}' is only {words} words. Needs substantive analysis.")

    # Required keywords
    missing = [kw for kw in keywords if not re.search(kw, content, re.IGNORECASE)]
    if missing:
        warnings.append(f"INCOMPLETE: '{heading}' missing key analysis: {', '.join(missing)}")

for w in warnings:
    print(w)
PYEOF
  )

  if [ -n "$section_warnings" ]; then
    warnings="${warnings}\n${section_warnings}"
  fi

  # --- Cross-section consistency checks (Python for robustness) ---
  cross_warnings=$(python3 - "$CLAUDE_FILE_PATH" << 'PYEOF2'
import sys, re

with open(sys.argv[1]) as f:
    report = f.read()

warnings = []

# Verdict must have ranked root causes
m = re.search(r'## 1.*?Verdict(.*?)## 2', report, re.DOTALL)
if m:
    verdict = m.group(1)
    rc_count = len(re.findall(r'(?:Rank|root cause|\| \d)', verdict, re.IGNORECASE))
    if rc_count < 2:
        warnings.append("VERDICT: Does not list ranked root causes. Must have top 3 with clear ranking.")

# Recommended Fixes must have priority levels
m = re.search(r'Recommended Fixes(.*)', report, re.DOTALL)
if m:
    fixes = m.group(1)
    priorities = len(re.findall(r'(CRITICAL|HIGH|MEDIUM|LOW|\[\d\]|^\d+\.)', fixes, re.IGNORECASE | re.MULTILINE))
    if priorities < 3:
        warnings.append("FIXES: Recommendations lack priority ranking. Each fix needs: priority level, specific action, expected impact.")

# Score Analysis must have actual numbers
m = re.search(r'Score Analysis(.*?)## 3', report, re.DOTALL)
if m:
    scores_sec = m.group(1)
    numbers = len(re.findall(r'\d+\.\d{2,}', scores_sec))
    if numbers < 10:
        warnings.append(f"SCORES: Only {numbers} precise numeric values in Score Analysis. Need scores, thresholds, FAR/recall at multiple operating points.")

for w in warnings:
    print(w)
PYEOF2
  )

  if [ -n "$cross_warnings" ]; then
    warnings="${warnings}\n${cross_warnings}"
  fi

  if [ -n "$warnings" ]; then
    echo -e "PHASE COMPLETENESS ISSUES:$warnings"
  fi
fi
