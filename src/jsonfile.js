import fs from "node:fs";
import path from "node:path";

/** Reads a JSON file; returns `fallback` if it is missing or unreadable. */
export function readJson(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    console.warn(`[store] ${filePath} is unreadable; starting fresh`);
    return fallback;
  }
}

/** Writes JSON via a temp file and rename, so a crash never leaves a half-written file. No-op without a path. */
export function writeJson(filePath, data) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}
