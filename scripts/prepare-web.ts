import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
const target = path.resolve("apps/web/public/monaco/vs");
await mkdir(target, { recursive: true });
await cp(path.resolve("apps/web/node_modules/monaco-editor/min/vs"), target, {
  recursive: true,
});
