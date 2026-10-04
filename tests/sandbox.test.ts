import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTarget } from "../apps/service/src/build-target.ts";

test("the build is the candidate until that commit is merged", () => {
  assert.equal(buildTarget(undefined), null);
  assert.equal(buildTarget({ data: {} }), null);
  assert.deepEqual(buildTarget({ data: { baseSha: "base" } }), { ref: "main" });
  assert.deepEqual(
    buildTarget({ data: { baseSha: "base", candidateSha: "cand" } }),
    { ref: "candidate", sha: "cand" },
  );
  assert.deepEqual(
    buildTarget({
      data: { baseSha: "base", candidateSha: "cand", mergedSha: "cand" },
    }),
    { ref: "main" },
  );
});
