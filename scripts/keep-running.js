// Keeps the agent running on a Mac (`npm run start:awake`):
// - stops the Mac from going to sleep on its idle timeout while this runs
//   (caffeinate -i). The screen can still turn off and lock as usual.
// - restarts the agent if it stops unexpectedly, e.g. WhatsApp disconnected
//   while the Mac was asleep with the lid closed. Ctrl+C stops everything.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

try {
  process.loadEnvFile(".env"); // only for DATA_DIR; the agent loads .env itself too
} catch {}
const profileDir = path.join(path.resolve(process.env.DATA_DIR || ".data"), "session", "session");

const RESTART_MIN_MS = 10_000;
const RESTART_MAX_MS = 5 * 60_000;
const HEALTHY_AFTER_MS = 10 * 60_000; // a run this long resets the restart backoff

let child = null;
let stopping = false;
let backoff = RESTART_MIN_MS;

if (process.platform === "darwin") {
  // -w: caffeinate ends by itself when this process ends, even if it crashes.
  spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).on("error", (err) =>
    console.warn(`[keep-running] could not prevent sleep: ${err.message}`),
  );
  console.log("[keep-running] Your Mac won't sleep on its idle timeout while the agent runs (the screen still can).");
} else {
  console.warn("[keep-running] Sleep prevention only works on macOS; restarts still work.");
}

/**
 * A crashed agent can leave its Chrome running, holding the WhatsApp login
 * folder; the next start would then fail. Close that Chrome and its locks.
 */
function cleanUpBrowser() {
  try {
    const pattern = `--user-data-dir=${profileDir}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // pkill takes a regex
    execFileSync("pkill", ["-9", "-f", "--", pattern], { stdio: "ignore" });
  } catch {} // pkill exits with 1 when nothing matched
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    fs.rmSync(path.join(profileDir, lock), { force: true });
  }
}

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, ["--env-file-if-exists=.env", "src/index.js"], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    child = null;
    if (code !== 0 || stopping) cleanUpBrowser();
    if (stopping) return process.exit(0);
    if (code === 0) {
      console.log("[keep-running] Agent stopped.");
      return process.exit(0);
    }
    if (Date.now() - startedAt > HEALTHY_AFTER_MS) backoff = RESTART_MIN_MS;
    console.error(`[keep-running] Agent stopped (${signal || `exit code ${code}`}); restarting in ${Math.round(backoff / 1000)}s...`);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, RESTART_MAX_MS);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}

start();
