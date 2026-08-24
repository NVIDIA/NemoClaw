/**
 * Read bounded complete pages from one GitHub REST GET endpoint.
 */
export default async function read_github_pages(input: {
  workdir: string;
  repository: string;
  path: string;
  pageSize?: Integer;
  pageLimit?: Integer;
}): Promise<{ items: Open<{}>[]; pagesRead: Integer; truncated: boolean }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository))
    throw new Error("repository must be owner/name");
  if (
    !/^[A-Za-z0-9_./?=&%:+-]+$/u.test(input.path) ||
    input.path.startsWith("-") ||
    input.path.startsWith("/") ||
    /^https?:/iu.test(input.path)
  )
    throw new Error("path must be a repository-relative GitHub REST endpoint");
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(input.path);
  } catch {
    throw new Error("path must use valid percent encoding");
  }
  if (
    decodedPath.split(/[/?]/u).some((segment) => segment === "." || segment === "..") ||
    /%2f|%5c/iu.test(input.path)
  )
    throw new Error("path must not contain encoded separators or dot segments");
  const queryText = input.path.split("?", 2)[1] ?? "";
  if (queryText.split("&").some((entry) => /^(?:page|per_page)=/iu.test(entry)))
    throw new Error("path must not provide page or per_page parameters");
  const pageSize = input.pageSize ?? 100;
  const pageLimit = input.pageLimit ?? 10;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw new Error("pageSize must be an integer from 1 through 100");
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 20)
    throw new Error("pageLimit must be an integer from 1 through 20");
  const endpoint = "repos/" + input.repository + "/" + input.path;
  const separator = endpoint.includes("?") ? "&" : "?";
  const items = [];
  let pagesRead = 0;
  for (let page = 1; page <= pageLimit; page += 1) {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args: ["api", "--include", endpoint + separator + "per_page=" + pageSize + "&page=" + page],
    });
    const boundary = result.stdout.search(/\r?\n\r?\n/u);
    if (boundary < 0) throw new Error("GitHub REST response omitted headers");
    const separatorLength = result.stdout.slice(boundary).startsWith("\r\n\r\n") ? 4 : 2;
    const headers = result.stdout.slice(0, boundary);
    const body = result.stdout.slice(boundary + separatorLength);
    const value = JSON.parse(body || "null");
    if (
      !Array.isArray(value) ||
      value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))
    )
      throw new Error("GitHub REST page must be an array of objects");
    pagesRead += 1;
    if (items.length + value.length > 2000)
      throw new Error("GitHub REST pagination exceeded 2000 items");
    items.push(...value);
    if (JSON.stringify(items).length > 2000000)
      throw new Error("GitHub REST pagination exceeded bounded output");
    const hasNext = /^link:.*rel="next"/imu.test(headers);
    if (!hasNext) return { items, pagesRead, truncated: false };
    if (page === pageLimit) return { items, pagesRead, truncated: true };
  }
  throw new Error("GitHub REST pagination did not terminate");
}
