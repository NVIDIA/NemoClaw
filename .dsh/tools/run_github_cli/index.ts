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
  if (input.args.some((arg) => arg === "--hostname" || arg.startsWith("--hostname=")))
    throw new Error("GitHub hostname selection is not allowed");
  const command = input.args[0] ?? "";
  let operation = input.args[1] ?? "";
  if (command === "api") {
    const optionsWithValues = new Set([
      "--method",
      "-X",
      "-f",
      "-F",
      "--field",
      "--raw-field",
      "--input",
      "--jq",
      "--template",
      "--cache",
      "--hostname",
    ]);
    for (let index = 1; index < input.args.length; index += 1) {
      const arg = input.args[index] ?? "";
      if (optionsWithValues.has(arg)) {
        index += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      operation = arg;
      break;
    }
  }
  const allowed = {
    api: null,
    auth: new Set(["status"]),
    issue: new Set(["list", "view"]),
    pr: new Set(["checks", "create", "list", "view", "merge", "ready", "review"]),
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
  if (
    command === "api" &&
    operation !== "graphql" &&
    (!/^[A-Za-z0-9]/u.test(operation) || /[\s\\#]/u.test(operation) || operation.includes("://"))
  )
    throw new Error("GitHub API endpoint must be a relative GitHub API path");
  const methods = [];
  for (let index = 0; index < input.args.length; index += 1) {
    const arg = input.args[index];
    if (arg === "--method" || arg === "-X") {
      const value = input.args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error("GitHub API method option requires a value");
      methods.push(value);
      index += 1;
    } else if (/^--method=/u.test(arg) || /^-X.+/u.test(arg)) {
      const value = arg.replace(/^(?:--method=|-X)/u, "");
      if (!value) throw new Error("GitHub API method option requires a value");
      methods.push(value);
    }
  }
  if (methods.length > 1)
    throw new Error("GitHub API method option must not be specified more than once");
  const method = (methods[0] ?? "GET").toUpperCase();
  const fieldFlags = input.args.some((arg) => /^(?:-f|-F|--field|--raw-field)(?:=|$)/u.test(arg));
  const inputFlag = input.args.some((arg) => arg === "--input" || arg.startsWith("--input="));
  const queryArgument = input.args.find((arg) =>
    /^(?:query=|--raw-field=query=|--field=query=)/u.test(arg),
  );
  const queryIndex = input.args.findIndex(
    (arg, index) =>
      /^(?:-f|-F|--field|--raw-field)$/u.test(arg) && /^query=/u.test(input.args[index + 1] ?? ""),
  );
  const queryDocument = queryArgument ?? (queryIndex >= 0 ? input.args[queryIndex + 1] : undefined);
  const graphQlOperation = (() => {
    if (command !== "api" || operation !== "graphql" || queryDocument === undefined) return null;
    const document = queryDocument.replace(/^(?:query=|--raw-field=query=|--field=query=)/u, "");
    const lexical = document.replace(/#[^\r\n]*/gu, " ");
    const declarations = [...lexical.matchAll(/(?:^|[}\s])(query|mutation|subscription)\b/gu)].map(
      (match) => match[1],
    );
    return declarations.length === 1 ? declarations[0] : null;
  })();
  const graphQlRead = graphQlOperation === "query";
  const mutating =
    (command === "api" &&
      (operation === "graphql"
        ? !graphQlRead
        : method !== "GET" || ((fieldFlags || inputFlag) && methods.length === 0))) ||
    (command === "pr" && new Set(["create", "merge", "ready", "review"]).has(operation));
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
  const redact = (value) =>
    value
      .replace(/(authorization\s*:)[^\r\n]*/giu, "$1 [REDACTED]")
      .replace(
        /((?:[A-Z_][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)|TOKEN|KEY|SECRET|PASSWORD)\s*=).*/giu,
        "$1[REDACTED]",
      )
      .replace(/((?:cookie|set-cookie)\s*:)[^\r\n]*/giu, "$1 [REDACTED]")
      .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED]")
      .replace(
        /([?&](?:access_token|api_key|token|key|secret|password)=)[^&#\s]*/giu,
        "$1[REDACTED]",
      )
      .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
      .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED]")
      .replace(/\/(?:home|Users)\/[^/\s]+/gu, "/[HOME]")
      .replace(/(?:[A-Za-z]:\\Users\\)[^\\\r\n]+/gu, "C:\\Users\\[HOME]")
      .replace(/\/root(?=\/|\s|$)/gu, "/[HOME]");
  const redactJson = (value) => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactJson);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, redactJson(item)]),
      );
    return value;
  };
  const clip = (value, maxCharacters, maxLines, maxLineCharacters) => {
    const physical = String(value ?? "").split(/\r?\n/u);
    const selected = physical.slice(0, maxLines);
    const bounded = selected.map((line) => [...line].slice(0, maxLineCharacters).join(""));
    return [...bounded.join("\n")].slice(0, maxCharacters).join("");
  };
  if (!acceptedStatus) {
    const detail = clip(
      redact(result.stderr.text || result.stdout.text || "no diagnostic output"),
      2000,
      20,
      500,
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
  let stdout;
  try {
    stdout = JSON.stringify(redactJson(JSON.parse(result.stdout.text)));
    if (result.stdout.text.endsWith("\n")) stdout += "\n";
  } catch {
    stdout = redact(result.stdout.text);
  }
  const stderr = clip(redact(result.stderr.text), 20000, 200, 2000);
  if (stdout.length > 4000000)
    throw new Error(
      "GitHub CLI stdout exceeded the transport bound; project it with --jq or --json",
    );
  return { ok: acceptedStatus, code, stdout, stderr };
}
