export function buildTarget(run?: { data: Record<string, any> }):
  | { ref: "candidate"; sha: string }
  | { ref: "main" }
  | null {
  if (!run?.data?.baseSha) return null;
  if (run.data.candidateSha && run.data.mergedSha !== run.data.candidateSha)
    return { ref: "candidate", sha: run.data.candidateSha };
  return { ref: "main" };
}
