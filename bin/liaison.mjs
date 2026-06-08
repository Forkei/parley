#!/usr/bin/env node
// Launcher for the Liaison CLI. Runs ac.ts through the package's OWN tsx loader, resolved by
// absolute path so it works after `npm link` from any directory — no global tsx, no shell,
// cross-platform. The user's cwd is preserved (the per-directory account binding depends on it).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tsxEntry = createRequire(import.meta.url).resolve("tsx"); // absolute → cwd-independent
const child = spawn(
  process.execPath,
  ["--import", pathToFileURL(tsxEntry).href, join(here, "..", "ac.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
