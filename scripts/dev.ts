import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
await import("./prepare-web.ts");
const children = [
  spawn(process.execPath, ["--import", "tsx", "apps/service/src/index.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn("pnpm", ["--filter", "@colag/web", "dev"], {
    stdio: "inherit",
    env: process.env,
  }),
];
for (const child of children)
  child.on("exit", (code) => {
    if (code) console.error(`A service exited (${code}).`);
  });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit();
  });
