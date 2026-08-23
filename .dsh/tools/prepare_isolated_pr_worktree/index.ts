/**
 * Plan or prepare one caller-isolated exact-commit pull request worktree without changing the primary checkout.
 */
export default async function prepare_isolated_pr_worktree(input: {
  workdir: string;
  number: Integer;
  repo?: string;
  root: string;
  path?: string;
  isolationKey?: string;
  remote?: string;
  reuseExisting?: boolean;
  replaceExisting?: boolean;
  requirePrimaryClean?: boolean;
  requireOpen?: boolean;
  dryRun?: boolean;
  apply?: true;
}): Promise<{
  dryRun: boolean;
  apply: boolean;
  mutated: boolean;
  repo: string;
  remote: string;
  isolationKey: string;
  number: Integer;
  url: string;
  path: string;
  commit: string;
  baseCommit: string;
  baseBranch: string;
  sourceRepository: string;
  sourceBranch: string;
  maintainerCanModify: boolean;
  isDraft: boolean;
  state: string;
  action: "planned" | "created" | "reused" | "replaced";
  warning?: string;
}> {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  if (typeof input.workdir !== "string" || !input.workdir.trim())
    throw new Error("workdir is required");
  if (!Number.isSafeInteger(input.number) || input.number < 1)
    throw new Error("number must be a positive integer");
  if (typeof input.root !== "string" || !input.root.trim()) throw new Error("root is required");
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    root = input.root,
    remote = input.remote ?? "origin",
    reuseExisting = input.reuseExisting ?? false,
    replaceExisting = input.replaceExisting ?? false,
    requirePrimaryClean = input.requirePrimaryClean ?? false,
    requireOpen = input.requireOpen ?? true,
    dryRun = input.dryRun ?? true;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (
    typeof remote !== "string" ||
    !remote ||
    remote.length > 255 ||
    remote.startsWith("-") ||
    !/^[A-Za-z0-9._/-]+$/.test(remote)
  )
    throw new Error("Invalid Git remote");
  const safeAbsolute = (value, label) => {
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      value.length > 4096 ||
      /[\r\n\0]/.test(value) ||
      value === "/"
    )
      throw new Error(label + " must be a safe absolute path other than /");
  };
  safeAbsolute(root, "root");
  if (input.path !== undefined) safeAbsolute(input.path, "path");
  if (reuseExisting && replaceExisting)
    throw new Error("reuseExisting and replaceExisting cannot both be true");
  if (!dryRun && input.apply !== true)
    throw new Error("Worktree mutation requires dryRun:false and apply:true");
  let isolationKey = input.isolationKey;
  if (isolationKey === undefined) {
    const env = await tools.bash({
      command: "printf '%s' \"$DSH_SESSION_ID\"",
      workdir: input.workdir,
      description: "Read worktree isolation key",
      timeoutMs: 10000,
    });
    if (env.kind !== "foreground" || env.exitCode !== 0 || !env.stdout.text.trim())
      throw new Error("isolationKey is required outside a managed DSH session");
    isolationKey = env.stdout.text.trim();
  }
  if (typeof isolationKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(isolationKey))
    throw new Error("isolationKey must contain only letters, numbers, dot, underscore, or hyphen");
  const namespace = root + "/" + isolationKey,
    targetPath = input.path ?? namespace + "/" + input.number;
  if (targetPath === input.workdir)
    throw new Error("Isolated worktree path must differ from the primary checkout");
  const parts = (value) => value.split("/").filter(Boolean);
  const namespaceParts = parts(namespace),
    targetParts = parts(targetPath);
  if (
    targetParts.includes("..") ||
    targetParts.includes(".") ||
    namespaceParts.some((part, index) => targetParts[index] !== part) ||
    targetParts.length <= namespaceParts.length
  )
    throw new Error("path must be a strict descendant of the caller isolation namespace");
  const relativePath = targetParts.slice(namespaceParts.length).join("/");
  const namespaceGuardScript =
    'const fs=require("node:fs"),p=require("node:path");' +
    "const [rootInput,namespaceInput,candidateInput,primaryInput]=process.argv.slice(1);" +
    "const root=p.normalize(rootInput),namespace=p.normalize(namespaceInput),candidate=p.normalize(candidateInput);" +
    'const lstat=value=>{try{return fs.lstatSync(value)}catch(error){if(error&&error.code==="ENOENT")return null;throw error}};' +
    'const inside=(parent,child,allowEqual)=>{const relative=p.relative(parent,child);return(allowEqual||relative!=="")&&!p.isAbsolute(relative)&&relative!==".."&&!relative.startsWith(".."+p.sep)};' +
    "const projected=value=>{let current=value;const suffix=[];let status=lstat(current);while(!status){const parent=p.dirname(current);if(parent===current)process.exit(43);suffix.unshift(p.basename(current));current=parent;status=lstat(current)}let resolved=fs.realpathSync(current);for(const part of suffix)resolved=p.join(resolved,part);return p.normalize(resolved)};" +
    "try{" +
    "if(!inside(root,namespace,false)||!inside(namespace,candidate,true))process.exit(44);" +
    "const relative=p.relative(root,candidate),chain=[root];let cursor=root;" +
    "for(const part of(relative?relative.split(p.sep):[])){cursor=p.join(cursor,part);chain.push(cursor)}" +
    "for(let index=0;index<chain.length;index+=1){const status=lstat(chain[index]);if(!status)break;if(status.isSymbolicLink())process.exit(42);if(index<chain.length-1&&!status.isDirectory())process.exit(43)}" +
    "const canonicalRoot=projected(root),canonicalNamespace=projected(namespace),canonicalCandidate=projected(candidate);" +
    "if(!inside(canonicalRoot,canonicalNamespace,false)||!inside(canonicalNamespace,canonicalCandidate,true))process.exit(44);" +
    "if(primaryInput){const canonicalPrimary=projected(p.normalize(primaryInput));if(inside(canonicalPrimary,canonicalRoot,true)||inside(canonicalPrimary,canonicalCandidate,true))process.exit(45)}" +
    "}catch{process.exit(43)}";
  const guardNamespace = async (candidate, description, primaryRoot = "") => {
    const guarded = await tools.bash({
      command:
        "node -e " +
        quote(namespaceGuardScript) +
        " " +
        quote(root) +
        " " +
        quote(namespace) +
        " " +
        quote(candidate) +
        " " +
        quote(primaryRoot),
      workdir: input.workdir,
      description,
      timeoutMs: 10000,
    });
    if (guarded.kind !== "foreground")
      throw new Error("Isolation namespace validation did not finish");
    if (guarded.exitCode === 42)
      throw new Error("Isolation namespace contains a symlinked path component");
    if (guarded.exitCode === 44)
      throw new Error("Canonical worktree path escapes the caller isolation namespace");
    if (guarded.exitCode === 45)
      throw new Error("Isolation root and worktree path must be outside the primary checkout");
    if (guarded.exitCode !== 0) throw new Error("Could not validate isolation namespace");
  };
  await guardNamespace(targetPath, "Validate isolated worktree namespace");
  const primaryRootResult = await tools.bash({
    command: "git rev-parse --show-toplevel",
    workdir: input.workdir,
    description: "Resolve primary checkout root",
    timeoutMs: 10000,
  });
  if (
    primaryRootResult.kind !== "foreground" ||
    primaryRootResult.exitCode !== 0 ||
    primaryRootResult.stdout.truncated ||
    primaryRootResult.stderr.truncated ||
    primaryRootResult.stderr.text
  )
    throw new Error("Could not resolve primary checkout root");
  const primaryRoot = primaryRootResult.stdout.text.endsWith("\n")
    ? primaryRootResult.stdout.text.slice(0, -1)
    : primaryRootResult.stdout.text;
  safeAbsolute(primaryRoot, "primary checkout root");
  if (/[\r\n]/.test(primaryRoot)) throw new Error("Primary checkout root is not a single path");
  await guardNamespace(
    targetPath,
    "Validate isolated worktree outside primary checkout",
    primaryRoot,
  );
  const primary = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: true,
  });
  if (requirePrimaryClean && !primary.clean)
    throw new Error("Primary worktree has uncommitted changes");
  const canonical = await tools.read_nemoclaw_pr({
      workdir: input.workdir,
      number: input.number,
      repository: repo,
    }),
    detailResult = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "view",
        String(input.number),
        "--repo",
        repo,
        "--json",
        "number,url,state,isDraft,headRefOid,headRefName,headRepository,headRepositoryOwner,maintainerCanModify,baseRefName,baseRefOid",
      ],
      timeoutMs: 30000,
    }),
    item = JSON.parse(detailResult.stdout);
  if (
    item.number !== canonical.number ||
    item.url !== canonical.url ||
    item.state !== canonical.state ||
    item.isDraft !== canonical.isDraft ||
    item.headRefOid !== canonical.headRefOid ||
    item.baseRefName !== canonical.baseRefName
  )
    throw new Error("Pull request changed between canonical and detailed snapshots; retry");
  if (requireOpen && item.state !== "OPEN")
    throw new Error("PR #" + input.number + " state is " + item.state + "; an open PR is required");
  if (
    !/^[0-9a-f]{40}$/.test(String(item.headRefOid ?? "")) ||
    !/^[0-9a-f]{40}$/.test(String(item.baseRefOid ?? ""))
  )
    throw new Error("Pull request returned an invalid commit SHA");
  const result = {
    repo,
    remote,
    isolationKey,
    number: item.number,
    url: item.url,
    path: relativePath,
    commit: item.headRefOid,
    baseCommit: item.baseRefOid,
    baseBranch: item.baseRefName,
    sourceRepository:
      item.headRepository?.nameWithOwner ??
      (item.headRepositoryOwner?.login ?? "") + "/" + (item.headRepository?.name ?? ""),
    sourceBranch: item.headRefName,
    maintainerCanModify: item.maintainerCanModify,
    isDraft: item.isDraft,
    state: item.state,
  };
  if (dryRun)
    return {
      dryRun: true,
      apply: false,
      mutated: false,
      ...result,
      action: "planned",
      warning: "No directory, ref, or worktree was changed.",
    };
  const run = async (command, description, timeoutMs = 30000, workdir = input.workdir) => {
    const r = await tools.bash({ command, workdir, description, timeoutMs });
    if (r.kind !== "foreground") throw new Error(description + " did not finish");
    if (r.exitCode !== 0) {
      const raw = r.stderr.text || r.stdout.text;
      const safe = raw
        .replaceAll(targetPath, "[worktree]")
        .replaceAll(namespace, "[isolation-namespace]")
        .replaceAll(root, "[isolation-root]")
        .replaceAll(input.workdir, "[checkout]");
      const diagnostic = await tools.project_diagnostic_text({
        lines: [safe],
        sourceTruncated: r.stderr.truncated || r.stdout.truncated,
        maxLines: 20,
        maxCharacters: 4000,
        maxLineCharacters: 1000,
      });
      throw new Error(diagnostic.text || description + " failed");
    }
    return r.stdout.text;
  };
  await run(
    "mkdir -p " + quote(targetPath.slice(0, targetPath.lastIndexOf("/"))),
    "Create isolated worktree parent",
    10000,
  );
  await guardNamespace(targetPath, "Revalidate isolated worktree namespace", primaryRoot);
  await run(
    "git fetch " +
      quote(remote) +
      " " +
      quote("+refs/pull/" + input.number + "/head:refs/remotes/pull/" + input.number),
    "Fetch exact pull request commit",
    120000,
  );
  const fetched = (
    await run(
      "git rev-parse " + quote("refs/remotes/pull/" + input.number),
      "Verify fetched pull request commit",
      10000,
    )
  ).trim();
  if (fetched !== item.headRefOid)
    throw new Error("Latest PR commit changed during preparation; retry with a fresh snapshot");
  const listed = await run("git worktree list --porcelain", "List registered Git worktrees", 30000),
    registered = new Map();
  let entry = null;
  for (const line of listed.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      entry = { path: line.slice(9), head: "", detached: false };
      registered.set(entry.path, entry);
    } else if (entry && line.startsWith("HEAD ")) entry.head = line.slice(5);
    else if (entry && line === "detached") entry.detached = true;
  }
  let action = "created";
  const registeredEntry = registered.get(targetPath);
  if (registeredEntry) {
    const checkout = await tools.read_git_checkout({
      workdir: targetPath,
      includeRoot: false,
      includeBranch: false,
      includeStatus: true,
    });
    if (!checkout.clean)
      throw new Error(
        "Worktree " + relativePath + " has uncommitted changes and will not be reused or replaced",
      );
    if (!registeredEntry.detached)
      throw new Error("Existing worktree is branch-attached and will not be reused or replaced");
    const resolved = checkout.head;
    if (resolved === item.headRefOid) {
      if (!reuseExisting)
        throw new Error(
          "Worktree " +
            relativePath +
            " already exists. Pass reuseExisting:true to reuse this clean exact-commit worktree.",
        );
      action = "reused";
    } else {
      if (!replaceExisting)
        throw new Error(
          "Worktree " +
            relativePath +
            " is at " +
            resolved +
            "; expected " +
            item.headRefOid +
            ". Pass replaceExisting:true to replace this clean worktree.",
        );
      await guardNamespace(targetPath, "Validate stale worktree namespace", primaryRoot);
      await run(
        "git worktree remove " + quote(targetPath),
        "Remove stale isolated worktree",
        30000,
      );
      action = "replaced";
    }
  } else {
    const exists = await tools.bash({
      command: "test -e " + quote(targetPath),
      workdir: input.workdir,
      description: "Check isolated worktree path",
      timeoutMs: 10000,
    });
    if (exists.kind !== "foreground")
      throw new Error("Could not inspect worktree path " + relativePath);
    if (exists.exitCode === 0)
      throw new Error("Path " + relativePath + " exists but is not a registered Git worktree");
    if (exists.exitCode !== 1) throw new Error("Could not inspect worktree path " + relativePath);
  }
  if (action !== "reused") {
    await guardNamespace(targetPath, "Validate worktree creation namespace", primaryRoot);
    await run(
      "git worktree add --detach " + quote(targetPath) + " " + quote(item.headRefOid),
      "Create exact-commit worktree",
      30000,
    );
  }
  const prepared = await tools.read_git_checkout({
    workdir: targetPath,
    includeRoot: false,
    includeBranch: false,
    includeStatus: false,
  });
  if (prepared.head !== item.headRefOid)
    throw new Error("Prepared worktree resolved to an unexpected commit");
  return { dryRun: false, apply: true, mutated: action !== "reused", ...result, action };
}
