/**
 * Plan or remove explicit clean detached worktrees under one guarded isolation root.
 */
export default async function remove_isolated_pr_worktrees(input: {
  workdir: string;
  paths: string[];
  root: string;
  failure?: "fail-fast" | "settled";
  dryRun?: boolean;
  apply?: true;
  isolationKey: string;
}): Promise<{
  dryRun: boolean;
  apply: boolean;
  mutated: boolean;
  failure: "fail-fast" | "settled";
  count: Integer;
  results: { path: string; head: string; action: "planned" | "removed" }[];
  errors: { path: string; message: string }[];
}> {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  if (typeof input.workdir !== "string" || !input.workdir.trim())
    throw new Error("workdir is required");
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 50)
    throw new Error("paths must contain 1 to 50 worktree paths");
  if (typeof input.root !== "string" || !input.root.trim()) throw new Error("root is required");
  const paths = [...new Set(input.paths)],
    root = input.root,
    isolationKey = input.isolationKey,
    dryRun = input.dryRun ?? true,
    failure = input.failure ?? "fail-fast";
  if (!["fail-fast", "settled"].includes(failure))
    throw new Error("failure must be fail-fast or settled");
  if (typeof isolationKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(isolationKey))
    throw new Error("isolationKey is invalid");
  const namespace = root + "/" + isolationKey,
    parts = (value) => value.split("/").filter(Boolean),
    namespaceParts = parts(namespace);
  const safe = (p) => {
    if (typeof p !== "string" || !p.startsWith("/") || p.length > 4096 || /[\r\n\0]/.test(p))
      return false;
    const targetParts = parts(p);
    return (
      !targetParts.includes("..") &&
      !targetParts.includes(".") &&
      targetParts.length > namespaceParts.length &&
      namespaceParts.every((part, index) => targetParts[index] === part)
    );
  };
  if (
    typeof root !== "string" ||
    !root.startsWith("/") ||
    root === "/" ||
    /[\r\n\0]/.test(root) ||
    paths.some((p) => !safe(p))
  )
    throw new Error("Every path must be a strict descendant of the caller isolation namespace");
  if (!dryRun && input.apply !== true)
    throw new Error("Worktree removal requires dryRun:false and apply:true");
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
  const primaryRootResult = await tools.bash({
    command: "git rev-parse --show-toplevel",
    workdir: input.workdir,
    description: "Resolve primary checkout root for cleanup",
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
  if (
    !primaryRoot.startsWith("/") ||
    primaryRoot === "/" ||
    primaryRoot.length > 4096 ||
    /[\r\n\0]/.test(primaryRoot)
  )
    throw new Error("Primary checkout root is not a safe absolute path");
  const results = [],
    errors = [],
    unsafePaths = new Set();
  for (const path of paths) {
    try {
      await guardNamespace(path, "Validate cleanup worktree namespace", primaryRoot);
    } catch (error) {
      if (failure === "fail-fast") throw error;
      unsafePaths.add(path);
      errors.push({
        path: parts(path).slice(namespaceParts.length).join("/"),
        message: error instanceof Error ? error.message : "Worktree cleanup failed",
      });
    }
  }
  if (unsafePaths.size === paths.length)
    return {
      dryRun,
      apply: !dryRun,
      mutated: false,
      failure,
      count: 0,
      results,
      errors,
    };
  const listed = await tools.bash({
    command: "git worktree list --porcelain",
    workdir: input.workdir,
    description: "List registered worktrees for cleanup",
    timeoutMs: 30000,
  });
  if (listed.kind !== "foreground" || listed.exitCode !== 0)
    throw new Error("Could not list registered worktrees");
  const registered = new Map();
  let entry = null;
  for (const line of listed.stdout.text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      entry = { path: line.slice(9), head: "", branch: null, detached: false };
      registered.set(entry.path, entry);
    } else if (entry && line.startsWith("HEAD ")) entry.head = line.slice(5);
    else if (entry && line.startsWith("branch ")) entry.branch = line.slice(7);
    else if (entry && line === "detached") entry.detached = true;
  }
  for (const path of paths) {
    const pathIdentifier = parts(path).slice(namespaceParts.length).join("/");
    if (unsafePaths.has(path)) continue;
    try {
      await guardNamespace(path, "Revalidate cleanup worktree namespace", primaryRoot);
      const item = registered.get(path);
      if (!item) throw new Error("Path is not a registered Git worktree");
      if (!item.detached)
        throw new Error("Worktree is branch-attached; cleanup only removes detached worktrees");
      const checkout = await tools.read_git_checkout({
        workdir: path,
        includeRoot: false,
        includeBranch: false,
        includeStatus: true,
      });
      if (!checkout.clean) throw new Error("Worktree has uncommitted changes");
      if (dryRun) results.push({ path: pathIdentifier, head: checkout.head, action: "planned" });
      else {
        await guardNamespace(path, "Validate worktree removal namespace", primaryRoot);
        const remove = await tools.bash({
          command: "git worktree remove " + quote(path),
          workdir: input.workdir,
          description: "Remove clean isolated worktree",
          timeoutMs: 30000,
        });
        if (remove.kind !== "foreground") throw new Error("Worktree removal did not finish");
        if (remove.exitCode !== 0) {
          const safe = (remove.stderr.text || remove.stdout.text)
            .replaceAll(path, "[worktree]")
            .replaceAll(namespace, "[isolation-namespace]")
            .replaceAll(root, "[isolation-root]")
            .replaceAll(input.workdir, "[checkout]");
          const diagnostic = await tools.project_diagnostic_text({
            lines: [safe],
            sourceTruncated: remove.stderr.truncated || remove.stdout.truncated,
            maxLines: 20,
            maxCharacters: 4000,
            maxLineCharacters: 1000,
          });
          throw new Error(diagnostic.text || "Worktree removal failed");
        }
        results.push({ path: pathIdentifier, head: checkout.head, action: "removed" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worktree cleanup failed";
      errors.push({ path: pathIdentifier, message });
      if (failure === "fail-fast") throw error;
    }
  }
  return {
    dryRun,
    apply: !dryRun,
    mutated: !dryRun && results.length > 0,
    failure,
    count: results.length,
    results,
    errors,
  };
}
