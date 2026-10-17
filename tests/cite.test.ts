import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("the sample questions cite the necessary file or say nothing", () => {
  const result = spawnSync("python3", ["hackathon/amd-academy/mc3/selfcheck.py"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the support desk answers from the company documents or refuses", () => {
  const app = path.join(root, "hackathon/amd-academy/mc3/app.py");
  const corpus = path.join(root, "fixtures/desk");
  const ask = (query: string) => {
    const result = spawnSync(
      "python3",
      [app, "--corpus", corpus, "--query-id", "desk", "--query", query, "--stdout"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { answer: string; citations: string[] };
  };
  const days = ask("How many days does a customer have to return a lamp?");
  assert.equal(days.answer, "30");
  assert.deepEqual(days.citations, ["returns.txt"]);
  const price = ask("What does overnight shipping cost?");
  assert.equal(price.answer, "");
  assert.deepEqual(price.citations, []);
});
