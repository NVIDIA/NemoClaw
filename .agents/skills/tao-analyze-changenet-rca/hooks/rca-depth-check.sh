#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Deep quality and analytical rigor validation for RCA reports
# Goes beyond word counts — validates analytical chain: evidence → finding → root cause → fix
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then

  python3 - "$CLAUDE_FILE_PATH" << 'PYEOF'
import sys, re

report_path = sys.argv[1]
with open(report_path) as f:
    report = f.read()

warnings = []

# ==========================================================================
# 1. BASIC DEPTH CHECKS (upgraded thresholds)
# ==========================================================================
word_count = len(report.split())
if word_count < 4000:
    warnings.append(f"THIN REPORT: {word_count} words (need 4000+). A rigorous RCA with visual evidence, per-sample tables, and counterfactuals requires depth.")

table_rows = len([l for l in report.splitlines() if l.strip().startswith('|') and '---' not in l])
if table_rows < 50:
    warnings.append(f"INSUFFICIENT TABLES: {table_rows} data rows (need 50+). Every defect sample, every FP, every component type, every simulation needs a row.")

# ==========================================================================
# 2. ANALYTICAL CHAIN: Evidence → Finding → Root Cause → Fix
# ==========================================================================

# 2a. Count distinct root causes identified
root_causes = re.findall(r'root cause', report, re.IGNORECASE)
if len(root_causes) < 3:
    warnings.append("WEAK ROOT CAUSE ANALYSIS: Fewer than 3 root causes identified. Most failures have multiple contributing causes.")

# 2b. Every root cause in Verdict should have a counterfactual simulation
verdict_section = ""
m = re.search(r'## 1.*?Verdict(.*?)## 2', report, re.DOTALL)
if m:
    verdict_section = m.group(1)
counterfactual_section = ""
m = re.search(r'Counterfactual(.*?)## (?:9|Recommended)', report, re.DOTALL)
if m:
    counterfactual_section = m.group(1)

# Extract root cause keywords from verdict
rc_keywords = re.findall(r'(?:root cause|Rank \d)[^|]*?\|[^|]*?\*\*([^*]+)\*\*', verdict_section)
if not rc_keywords:
    rc_keywords = re.findall(r'\*\*([^*]{10,60})\*\*', verdict_section)

for rc in rc_keywords[:5]:
    # Check if this root cause has a corresponding simulation
    rc_words = [w.lower() for w in rc.split() if len(w) > 3]
    found_in_cf = any(w in counterfactual_section.lower() for w in rc_words[:3])
    if not found_in_cf and counterfactual_section:
        warnings.append(f"UNQUANTIFIED ROOT CAUSE: '{rc[:50]}' identified in Verdict but has no counterfactual simulation. Every root cause needs a what-if KPI impact number.")

# ==========================================================================
# 3. COUNTERFACTUAL RIGOR
# ==========================================================================

# 3a. Must have actual before/after numbers (not just prose)
cf_numbers = re.findall(r'(\d+\.?\d*)\s*%', counterfactual_section) if counterfactual_section else []
if len(cf_numbers) < 6:
    warnings.append(f"WEAK COUNTERFACTUALS: Only {len(cf_numbers)} percentage values in counterfactual section. Need before/after FAR for each simulation.")

# 3b. Must have a "minimum viable fix path" or prioritized action plan
if not re.search(r'minimum.*fix|fix.*path|priorit', counterfactual_section, re.IGNORECASE):
    warnings.append("MISSING FIX PATH: No 'Minimum Viable Fix Path' section. Must prioritize fixes by impact × feasibility.")

# 3c. Must state whether target KPI is reachable
if not re.search(r'reachable|unreachable|not.*achievable|cannot.*reach|fundamentally', report, re.IGNORECASE):
    warnings.append("NO KPI REACHABILITY VERDICT: Must explicitly state whether target KPI is achievable and why/why not.")

# ==========================================================================
# 4. VISUAL EVIDENCE DEPTH
# ==========================================================================

# 4a. Golden audit must have mean intensity numbers
golden_section = ""
m = re.search(r'Golden.*?Audit(.*?)(?:## \d|### \d\.(?!1))', report, re.DOTALL | re.IGNORECASE)
if m:
    golden_section = m.group(1)
intensity_numbers = re.findall(r'(?:mean|intensity|avg)[^0-9]*(\d+\.?\d*)', golden_section, re.IGNORECASE) if golden_section else []
if len(intensity_numbers) < 3:
    warnings.append(f"GOLDEN AUDIT SHALLOW: Only {len(intensity_numbers)} intensity measurements. Every audited golden image needs mean pixel intensity reported.")

# 4b. Failure mode clustering must assign a mode to each defect
fm_section = ""
m = re.search(r'Failure Mode Clustering(.*?)(?:## \d|### \d\.(?!2))', report, re.DOTALL)
if m:
    fm_section = m.group(1)
fm_categories = re.findall(r'(obvious_defect|dark_golden|framing_mismatch|subtle_defect|mislabel)', fm_section, re.IGNORECASE)
unique_modes = set(c.lower() for c in fm_categories)
if len(unique_modes) < 2:
    warnings.append(f"FAILURE CLUSTERING SHALLOW: Only {len(unique_modes)} failure mode categories used. Expect 3+ (obvious_defect, dark_golden, framing_mismatch, subtle_defect, etc.).")

# 4c. FP analysis must identify FP cause for each top-N sample
fp_section = ""
m = re.search(r'False Positive(.*?)(?:## \d|### \d\.(?!3))', report, re.DOTALL)
if m:
    fp_section = m.group(1)
fp_causes = re.findall(r'(Solder Reflectance|Position Shift|Lighting Variation|Golden Quality|Board Background)', fp_section, re.IGNORECASE)
if len(fp_causes) < 5:
    warnings.append(f"FP ANALYSIS SHALLOW: Only {len(fp_causes)} FP cause assignments. Top 10 FPs each need a classified cause.")

# ==========================================================================
# 5. TRAINING ANALYSIS DEPTH
# ==========================================================================

# 5a. Must discuss training defect images viewed
if not re.search(r'training.*defect.*view|viewed.*training|train.*sample.*image', report, re.IGNORECASE):
    # Looser check
    if not re.search(r'training.*(?:Missing|defect).*(?:obvious|visible|empty|pads)', report, re.IGNORECASE):
        warnings.append("NO TRAINING IMAGE REVIEW: Must view and describe actual training defect images, not just count them.")

# 5b. Must compute effective over-emphasis (sampler × class weight)
if not re.search(r'over-emphasis|effective.*\d+x|\d+\s*×\s*\d+', report, re.IGNORECASE):
    warnings.append("MISSING OVER-EMPHASIS CALCULATION: Must compute sampler_rate × cls_weight to show effective defect emphasis.")

# 5c. Must report LR at checkpoint epoch
if not re.search(r'LR.*(?:epoch|checkpoint).*(?:1e-|10-|dead|zero|nearly)', report, re.IGNORECASE):
    if not re.search(r'learning rate.*\d+\.\d+e-\d+', report, re.IGNORECASE):
        warnings.append("MISSING LR ANALYSIS: Must compute effective learning rate at the inference checkpoint epoch.")

# ==========================================================================
# 6. EXPLORATORY FINDINGS DEPTH
# ==========================================================================
exp_section = ""
m = re.search(r'Exploratory Findings(.*?)## (?:8|Counterfactual)', report, re.DOTALL)
if m:
    exp_section = m.group(1)

if exp_section:
    exp_words = len(exp_section.split())
    if exp_words < 300:
        warnings.append(f"EXPLORATORY SECTION THIN: Only {exp_words} words. Agents E & F should surface unique findings not in structured phases.")

    # Must have at least some of: random sampling, anomalies, correlations, data integrity
    exp_checks = {
        'random sampl': 'Random sampling results',
        'anomal': 'Score anomaly findings',
        'correlat': 'Metadata correlation analysis',
        'integrity': 'Data integrity audit',
        'distribution.*shape|bimodal|skew': 'Score distribution shape analysis',
    }
    missing_exp = []
    for pattern, name in exp_checks.items():
        if not re.search(pattern, exp_section, re.IGNORECASE):
            missing_exp.append(name)
    if len(missing_exp) >= 3:
        warnings.append(f"EXPLORATORY GAPS: Missing {len(missing_exp)} sub-analyses: {', '.join(missing_exp[:3])}")
else:
    warnings.append("NO EXPLORATORY SECTION: Agents E & F findings must be included.")

# ==========================================================================
# 7. CROSS-REFERENCE CONSISTENCY
# ==========================================================================

# 7a. Tier classification must match score gap
tier_match = re.search(r'Tier\s*(?::?\s*)(\d)', report)
gap_match = re.search(r'(?:score gap|gap)[^0-9]*(\d+\.\d+)', report, re.IGNORECASE)
if tier_match and gap_match:
    tier = int(tier_match.group(1))
    gap = float(gap_match.group(1))
    expected_tier = 1 if gap < 0.03 else (2 if gap < 0.10 else (3 if gap < 0.20 else 4))
    if tier != expected_tier:
        warnings.append(f"TIER MISMATCH: Report says Tier {tier} but score gap {gap} → should be Tier {expected_tier}.")

# 7b. FAR at 100% recall should be consistent between Score Analysis and Counterfactual baseline
far_values = re.findall(r'(?:FAR.*100%.*recall|100%.*recall.*FAR)[^0-9]*(\d+\.?\d*)%', report, re.IGNORECASE)
if len(far_values) >= 2:
    far_nums = [float(v) for v in far_values[:2]]
    if abs(far_nums[0] - far_nums[1]) > 1.0:
        warnings.append(f"INCONSISTENT FAR: Score Analysis says {far_nums[0]}% but Counterfactual says {far_nums[1]}%. Numbers must be consistent.")

# ==========================================================================
# OUTPUT
# ==========================================================================
if warnings:
    print("ANALYTICAL RIGOR ISSUES:")
    for w in warnings:
        print(f"  - {w}")
else:
    print("Depth check passed: all analytical rigor criteria met.")

PYEOF
fi
