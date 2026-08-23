/**
 * Redact and bound selected diagnostic lines with explicit clipping evidence.
 */
export default async function project_diagnostic_text(input: {
  lines: string[];
  clipMode?: "head" | "tail";
  lineClipMode?: "head" | "tail";
  maxLines?: Integer;
  maxCharacters?: Integer;
  maxLineCharacters?: Integer;
  sourceTruncated?: boolean;
}): Promise<{
  text: string;
  sourceTruncated: boolean;
  lineClipped: boolean;
  lineCharacterClipped: boolean;
  textClipped: boolean;
  truncated: boolean;
  clipMode: "head" | "tail";
  selectedLines: Integer;
  returnedLines: Integer;
  omittedLines: Integer;
}> {
  if (
    !Array.isArray(input.lines) ||
    input.lines.length > 20000 ||
    input.lines.some((line) => typeof line !== "string" || line.length > 4000000)
  )
    throw new Error("lines must contain at most 20000 bounded strings");
  if (input.lines.reduce((total, line) => total + line.length, 0) > 4000000)
    throw new Error("diagnostic input exceeds 4000000 code units");
  const physicalLines = input.lines.flatMap((line) => line.split(/\r?\n/u));
  const clipMode = input.clipMode ?? "tail";
  const lineClipMode = input.lineClipMode ?? clipMode;
  const maxLines = input.maxLines ?? 120;
  const maxCharacters = input.maxCharacters ?? 40000;
  const maxLineCharacters = input.maxLineCharacters ?? 4000;
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 20000)
    throw new Error("maxLines must be an integer from 1 through 20000");
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 4000000)
    throw new Error("maxCharacters must be an integer from 1 through 4000000");
  if (!Number.isInteger(maxLineCharacters) || maxLineCharacters < 1 || maxLineCharacters > 4000000)
    throw new Error("maxLineCharacters must be an integer from 1 through 4000000");
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
  const chosen =
    clipMode === "head" ? physicalLines.slice(0, maxLines) : physicalLines.slice(-maxLines);
  let lineCharacterClipped = false;
  const boundedLines = chosen.map((raw) => {
    const characters = [...redact(raw)];
    if (characters.length <= maxLineCharacters) return characters.join("");
    lineCharacterClipped = true;
    return (
      lineClipMode === "head"
        ? characters.slice(0, maxLineCharacters)
        : characters.slice(-maxLineCharacters)
    ).join("");
  });
  const joined = boundedLines.join("\n");
  const joinedCharacters = [...joined];
  const textClipped = joinedCharacters.length > maxCharacters;
  const text = (
    textClipped
      ? clipMode === "head"
        ? joinedCharacters.slice(0, maxCharacters)
        : joinedCharacters.slice(-maxCharacters)
      : joinedCharacters
  ).join("");
  const lineClipped = physicalLines.length > maxLines;
  const sourceTruncated = input.sourceTruncated === true;
  const returnedLines = text === "" ? (boundedLines.length > 0 ? 1 : 0) : text.split("\n").length;
  return {
    text,
    sourceTruncated,
    lineClipped,
    lineCharacterClipped,
    textClipped,
    truncated: sourceTruncated || lineClipped || lineCharacterClipped || textClipped,
    clipMode,
    selectedLines: physicalLines.length,
    returnedLines,
    omittedLines: Math.max(0, physicalLines.length - returnedLines),
  };
}
