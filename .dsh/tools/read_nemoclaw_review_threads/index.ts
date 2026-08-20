/**
 * Read complete bounded review-thread pages for one exact NemoClaw pull request snapshot.
 */
export default async function read_nemoclaw_review_threads(input: {
  workdir: string;
  number: Integer;
  repository?: string;
  expectedHeadSha: string;
  pageLimit?: Integer;
}): Promise<{
  pagesRead: Integer;
  complete: boolean;
  total: Integer;
  unresolved: Integer;
  threads: {
    id: string;
    isResolved: boolean;
    comments: {
      id: string;
      databaseId: Integer | null;
      body: string;
      path: string;
      line: Integer | null;
      url: string;
      author: string | null;
    }[];
  }[];
}> {
  if (!Number.isInteger(input.number) || input.number < 1)
    throw new Error("number must be a positive integer");
  if (!/^[0-9a-f]{40,64}$/u.test(input.expectedHeadSha))
    throw new Error("expectedHeadSha must be a full lowercase commit ID");
  const repository = input.repository ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error("repository must be owner/name");
  const pageLimit = input.pageLimit ?? 10;
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 20)
    throw new Error("pageLimit must be an integer from 1 through 20");
  const [owner, name] = repository.split("/");
  const threads = [];
  let cursor = null;
  for (let page = 1; page <= pageLimit; page += 1) {
    const query =
      "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:100){nodes{id databaseId body path line url author{login}}pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}}}";
    const args = [
      "api",
      "graphql",
      "-f",
      "query=" + query,
      "-f",
      "owner=" + owner,
      "-f",
      "name=" + name,
      "-F",
      "number=" + input.number,
    ];
    if (cursor !== null) args.push("-f", "cursor=" + cursor);
    const result = await tools.run_github_cli({ workdir: input.workdir, args });
    const pull = JSON.parse(result.stdout).data?.repository?.pullRequest;
    if (pull?.headRefOid !== input.expectedHeadSha)
      throw new Error("pull request commit changed while reading review threads");
    const connection = pull?.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes))
      throw new Error("GitHub GraphQL review-thread response was incomplete");
    if (typeof connection.pageInfo?.hasNextPage !== "boolean")
      throw new Error("GitHub review-thread pagination metadata was invalid");
    for (const thread of connection.nodes) {
      if (
        thread === null ||
        typeof thread !== "object" ||
        typeof thread.id !== "string" ||
        typeof thread.isResolved !== "boolean" ||
        !Array.isArray(thread.comments?.nodes)
      )
        throw new Error("GitHub review thread did not match the canonical contract");
      if (thread.comments?.pageInfo?.hasNextPage)
        throw new Error("GitHub review thread exceeded 100 comments");
      const comments = [];
      for (const comment of thread.comments.nodes) {
        const body = comment?.body;
        if (
          comment === null ||
          typeof comment !== "object" ||
          typeof comment.id !== "string" ||
          (comment.databaseId !== null && !Number.isSafeInteger(comment.databaseId)) ||
          typeof body !== "string" ||
          body.length > 20000 ||
          typeof comment.path !== "string" ||
          (comment.line !== null && !Number.isSafeInteger(comment.line)) ||
          typeof comment.url !== "string" ||
          (comment.author !== null && typeof comment.author?.login !== "string")
        )
          throw new Error("GitHub review comment did not match the canonical contract");
        comments.push({
          id: comment.id,
          databaseId: comment.databaseId,
          body,
          path: comment.path,
          line: comment.line,
          url: comment.url,
          author: comment.author?.login ?? null,
        });
        if (
          comments.length + threads.reduce((total, item) => total + item.comments.length, 0) >
          2000
        )
          throw new Error("GitHub review threads exceeded 2000 comments");
      }
      threads.push({ id: thread.id, isResolved: thread.isResolved, comments });
      if (JSON.stringify(threads).length > 2000000)
        throw new Error("GitHub review threads exceeded bounded output");
    }
    if (threads.length > 2000 || JSON.stringify(threads).length > 2000000)
      throw new Error("GitHub review threads exceeded bounded output");
    if (!connection.pageInfo?.hasNextPage)
      return {
        pagesRead: page,
        complete: true,
        total: threads.length,
        unresolved: threads.filter((thread) => !thread.isResolved).length,
        threads,
      };
    cursor = connection.pageInfo.endCursor;
    if (!cursor) throw new Error("GitHub review-thread pagination omitted its next cursor");
  }
  return {
    pagesRead: pageLimit,
    complete: false,
    total: threads.length,
    unresolved: threads.filter((thread) => !thread.isResolved).length,
    threads,
  };
}
