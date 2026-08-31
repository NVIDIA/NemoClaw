// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MANAGED_NPM_PROJECT_DISCOVERY_SOURCE = String.raw`
function addManagedNpmProjectPackageCandidates(
  projectsDir,
  dependencyName,
  packagePathSegments,
  addCandidate,
) {
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.join(projectsDir, entry.name);
    let dependencies;
    try {
      dependencies = JSON.parse(
        fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
      ).dependencies;
    } catch {
      continue;
    }
    if (!dependencies || !Object.hasOwn(dependencies, dependencyName)) continue;
    addCandidate(path.join(projectRoot, "node_modules", ...packagePathSegments));
  }
}
`;
