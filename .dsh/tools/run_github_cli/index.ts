/**
 * Execute one bounded GitHub CLI operation with consistent process and access-error handling.
 */
export default async function run_github_cli(input: {
  workdir: string;
  args: string[];
  acceptedExitCodes?: Integer[];
  timeoutMs?: Integer;
  apply?: boolean;
}): Promise<{ ok: boolean; code: Integer; stdout: string; stderr: string }> {
  if (input.args.length < 1 || input.args.length > 128)
    throw new Error("args must contain 1 through 128 entries");
  if (input.args.some((arg) => arg.length > 131072 || arg.includes("\0")))
    throw new Error("GitHub CLI arguments must be bounded text without NUL bytes");
  if (input.args.reduce((total, arg) => total + arg.length, 0) > 262144)
    throw new Error("GitHub CLI arguments exceed the total size bound");
  if (input.args.some((arg) => /^(?:-H|--header)$/u.test(arg) || /authorization\s*:/iu.test(arg)))
    throw new Error("credential-bearing GitHub CLI arguments are not allowed");
  const command = input.args[0] ?? "";
  const operation = input.args[1] ?? "";
  const allowed = {
    api: null,
    auth: new Set(["status"]),
    issue: new Set(["list", "view"]),
    pr: new Set(["checks", "list", "view", "merge", "ready", "review"]),
    repo: new Set(["view"]),
    run: new Set(["list", "view"]),
    workflow: new Set(["list", "view"]),
  };
  if (
    !Object.hasOwn(allowed, command) ||
    (allowed[command] !== null && !allowed[command].has(operation))
  )
    throw new Error("GitHub CLI command is outside the audited transport allowlist");
  if ((command === "auth" && operation !== "status") || input.args.includes("--show-token"))
    throw new Error("credential-exporting GitHub CLI operations are not allowed");
  const attachedMethod = input.args.find((arg) => /^(?:--method=|-X).+/u.test(arg));
  const methodIndex = input.args.findIndex((arg) => arg === "--method" || arg === "-X");
  if (methodIndex >= 0 && !input.args[methodIndex + 1])
    throw new Error("GitHub API method option requires a value");
  const method = (
    attachedMethod
      ? attachedMethod.replace(/^(?:--method=|-X)/u, "")
      : methodIndex >= 0
        ? input.args[methodIndex + 1]
        : "GET"
  ).toUpperCase();
  const fieldFlags = input.args.some((arg) => /^(?:-f|-F|--field|--raw-field)(?:=|$)/u.test(arg));
  const queryArgument = input.args.find((arg) =>
    /^(?:query=|--raw-field=query=|--field=query=)/u.test(arg),
  );
  const queryIndex = input.args.findIndex(
    (arg, index) =>
      /^(?:-f|-F|--field|--raw-field)$/u.test(arg) && /^query=/u.test(input.args[index + 1] ?? ""),
  );
  const queryDocument = queryArgument ?? (queryIndex >= 0 ? input.args[queryIndex + 1] : undefined);
  const graphQlRead =
    command === "api" &&
    operation === "graphql" &&
    queryDocument !== undefined &&
    !queryDocument.includes("@") &&
    !/(^|[^A-Za-z])mutation([^A-Za-z]|$)/iu.test(queryDocument);
  const mutating =
    (command === "api" &&
      (operation === "graphql"
        ? !graphQlRead
        : method !== "GET" || (fieldFlags && methodIndex < 0 && attachedMethod === undefined))) ||
    (command === "pr" && new Set(["merge", "ready", "review"]).has(operation));
  if (mutating && input.apply !== true)
    throw new Error("mutating GitHub CLI operations require apply: true");
  const accepted = input.acceptedExitCodes ?? [0];
  if (
    accepted.length < 1 ||
    accepted.length > 16 ||
    accepted.some((code) => !Number.isInteger(code) || code < 0 || code > 255)
  )
    throw new Error("acceptedExitCodes must contain 1 through 16 exit codes from 0 through 255");
  const timeoutMs = input.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error("timeoutMs must be an integer from 1000 through 300000");
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const result = await tools.bash({
    command: ["gh", ...input.args].map(quote).join(" "),
    workdir: input.workdir,
    description: "Run bounded GitHub CLI operation",
    timeoutMs,
  });
  if (result.kind !== "foreground")
    throw new Error("GitHub CLI operation did not return a foreground result");
  if (result.timedOut || result.aborted || result.signal !== null || result.sandbox?.denied)
    throw new Error("GitHub CLI operation did not terminate normally");
  if (result.stdout.truncated || result.stderr.truncated)
    throw new Error("GitHub CLI operation exceeded bounded process output");
  const code = result.exitCode ?? 1;
  const acceptedStatus = accepted.includes(code);
  if (!acceptedStatus) {
    const redact = (value) =>
      value
        .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
        .replace(/(authorization\s*[:=]\s*)(?:bearer|token|basic)\s+[^\s]+/giu, "$1[REDACTED]")
        .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY))=([^\s]+)/gu, "$1=[REDACTED]")
        .replace(/\/(?:home|Users)\/[^/\s]+/gu, "/home/[USER]");
    const detail = redact(result.stderr.text || result.stdout.text || "no diagnostic output").slice(
      0,
      2000,
    );
    const access =
      /(?:authentication|authorization|permission|forbidden|unauthorized|not logged|HTTP 40[13]|resource not accessible)/iu.test(
        detail,
      );
    throw new Error(
      (access
        ? "GitHub authentication or authorization failed: "
        : "GitHub CLI operation failed: ") + detail,
    );
  }
  const stderr = result.stderr.text
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/(authorization\s*[:=]\s*)(?:bearer|token|basic)\s+[^\s]+/giu, "$1[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY))=([^\s]+)/gu, "$1=[REDACTED]")
    .replace(/\/(?:home|Users)\/[^/\s]+/gu, "/home/[USER]");
  const stdout = result.stdout.text
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED]");
  return { ok: acceptedStatus, code, stdout, stderr };
}
