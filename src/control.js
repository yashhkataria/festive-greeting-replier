// Everything you can change from your phone: the kill switch, the model,
// contact lists and settings. State lives in one small JSON file that is
// re-read on every use, so changes from WhatsApp or the CLI apply to the
// running agent immediately and survive restarts. Phone changes override .env.
import fs from "node:fs";
import path from "node:path";
import { normaliseOccasion } from "./classifier.js";
import { parseClock, parseWindow } from "./time.js";

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

const LISTS = { close: "close people", ignore: "ignore list" };

/** Turns "sonnet" or "claude-sonnet-5-5" into a model id; returns null for anything else. */
export function resolveModel(name) {
  const key = (name || "").trim().toLowerCase();
  if (MODELS[key]) return MODELS[key];
  return Object.values(MODELS).includes(key) ? key : null;
}

function cleanList(change) {
  return {
    added: Array.isArray(change?.added) ? change.added : [],
    removed: Array.isArray(change?.removed) ? change.removed : [],
  };
}

export class ControlStore {
  /**
   * @param {string|null} filePath  null keeps state in memory only (tests).
   * @param {string} defaultModel
   */
  constructor(filePath, defaultModel = MODELS.opus) {
    this.filePath = filePath;
    this.defaultModel = resolveModel(defaultModel) || MODELS.opus;
    this.memory = {};
  }

  /**
   * @returns {{ paused: boolean, model: string, settings: object,
   *   lists: { close: { added: string[], removed: string[] }, ignore: { added: string[], removed: string[] } } }}
   */
  get() {
    let state = this.memory;
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      } catch {
        // A damaged file must never switch the agent on: treat it as paused.
        return { paused: true, model: this.defaultModel, settings: {}, lists: { close: cleanList(), ignore: cleanList() } };
      }
    }
    return {
      paused: state.paused === true,
      model: resolveModel(state.model) || this.defaultModel,
      settings: state.settings && typeof state.settings === "object" ? state.settings : {},
      lists: { close: cleanList(state.lists?.close), ignore: cleanList(state.lists?.ignore) },
    };
  }

  set(changes) {
    const next = { ...this.get(), ...changes };
    this.memory = next;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, this.filePath);
    }
    return next;
  }

  setting(name, value) {
    const settings = { ...this.get().settings };
    if (value === undefined) delete settings[name];
    else settings[name] = value;
    this.set({ settings });
  }
}

// --- contact lists ---

const isName = (entry) => /\p{L}/u.test(entry);
const digitsOf = (entry) => entry.replace(/\D/g, "");

/** Same person? Names compare case-insensitively; numbers match on their last digits (with or without country code). */
export function sameEntry(a, b) {
  if (isName(a) || isName(b)) return isName(a) && isName(b) && a.trim().toLowerCase() === b.trim().toLowerCase();
  const [x, y] = [digitsOf(a), digitsOf(b)];
  return x.length >= 8 && y.length >= 8 && (x.endsWith(y) || y.endsWith(x));
}

/** The list in effect: entries from .env/files, plus phone additions, minus phone removals. */
export function effectiveList(base, change) {
  const result = [];
  for (const entry of [...base, ...change.added]) {
    if (change.removed.some((r) => sameEntry(r, entry))) continue;
    if (!result.some((e) => sameEntry(e, entry))) result.push(entry);
  }
  return result;
}

function validEntry(entry) {
  return isName(entry) || digitsOf(entry).length >= 8;
}

function editList(control, listName, action, value, base) {
  const label = LISTS[listName];
  const change = control.get().lists[listName];
  const current = effectiveList(base, change);
  if (!action || action === "list" || action === "show") {
    return current.length ? `${label} (${current.length}):\n${current.map((e) => `• ${e}`).join("\n")}` : `The ${label} is empty.`;
  }
  if (!["add", "remove", "rm", "delete"].includes(action)) {
    return `Use "greeter ${listName} add Mom", "greeter ${listName} remove Mom" or "greeter ${listName} list".`;
  }
  const entries = (value || "").split(",").map((e) => e.trim()).filter(Boolean);
  if (!entries.length) return `Say who, e.g. "greeter ${listName} ${action} Mom" or a number with country code.`;
  const bad = entries.filter((e) => !validEntry(e));
  if (bad.length) return `Not a name or full phone number: ${bad.join(", ")}. Numbers need at least 8 digits.`;

  const lists = control.get().lists;
  const next = cleanList(lists[listName]);
  const done = [];
  const skipped = [];
  for (const entry of entries) {
    const present = effectiveList(base, next).some((e) => sameEntry(e, entry));
    if (action === "add") {
      if (present) {
        skipped.push(entry);
        continue;
      }
      next.removed = next.removed.filter((r) => !sameEntry(r, entry));
      if (!effectiveList(base, next).some((e) => sameEntry(e, entry))) next.added.push(entry);
      done.push(entry);
    } else if (action === "remove" || action === "rm" || action === "delete") {
      if (!present) {
        skipped.push(entry);
        continue;
      }
      next.added = next.added.filter((e) => !sameEntry(e, entry));
      if (base.some((e) => sameEntry(e, entry))) next.removed.push(entry);
      done.push(entry);
    } else {
      return `Use "greeter ${listName} add ...", "greeter ${listName} remove ..." or "greeter ${listName} list".`;
    }
  }
  control.set({ lists: { ...lists, [listName]: next } });
  const verb = action === "add" ? "Added to" : "Removed from";
  const parts = [];
  if (done.length) parts.push(`${verb} ${label}: ${done.join(", ")}.`);
  if (skipped.length) parts.push(`${action === "add" ? "Already on" : "Not on"} the ${label}: ${skipped.join(", ")}.`);
  return parts.join(" ");
}

// --- commands ---

const HELP = `Commands (send in "Message yourself"):
greeter status - is it on, today's replies, what's scheduled
greeter pause / resume - kill switch
greeter model opus|sonnet|haiku - Claude model
greeter close add|remove|list Mom - people you answer yourself
greeter ignore add|remove|list +91 98765 43210 - people never read
greeter quiet 23:00-08:00 | off - no replies in this window
greeter limit 40 - automatic replies per day (0 = no limit)
greeter delay 15-300 - random wait before replying, in seconds
greeter summary 21:30 | off - daily summary time
greeter only diwali,holi | all - which occasions to answer
greeter settings - show all settings
greeter reset <setting> - go back to the .env value`;

/**
 * Runs one control command and returns the text to show. Used by both the CLI
 * (`node scripts/control.js pause`) and the WhatsApp "greeter ..." commands.
 * @param {ControlStore} control
 * @param {string[]} args  e.g. ["model", "haiku"] or ["close", "add", "Mom"]
 * @param {{ status?: () => string, settings?: () => string, baseLists?: { close: () => string[], ignore: () => string[] } }} [info]
 *        details from the running agent; baseLists are the .env/file entries.
 */
export function runCommand(control, args, info = {}) {
  const command = (args[0] || "status").toLowerCase();
  const rest = args.slice(1);
  const value = rest.join(" ").trim();
  switch (command) {
    case "pause":
    case "stop":
    case "off":
      control.set({ paused: true });
      return "Greeter paused. Scheduled replies are cancelled and none will be sent until you resume it.";
    case "resume":
    case "start":
    case "on":
      control.set({ paused: false });
      return `Greeter resumed. Replying with ${control.get().model}.`;
    case "status": {
      const { paused, model } = control.get();
      const extra = info.status ? ` ${info.status()}` : "";
      return `Greeter is ${paused ? "PAUSED" : "ON"}. Model: ${model}.${extra}`;
    }
    case "model": {
      const model = resolveModel(value);
      if (!model) return `Unknown model "${value}". Choose: ${Object.keys(MODELS).join(", ")}.`;
      control.set({ model });
      return `Model switched to ${model}.`;
    }
    case "close":
    case "ignore": {
      const base = info.baseLists?.[command]?.() || [];
      return editList(control, command, (rest[0] || "list").toLowerCase(), rest.slice(1).join(" "), base);
    }
    case "quiet": {
      if (!value) return 'Say the hours, e.g. "greeter quiet 23:00-08:00", or "greeter quiet off".';
      try {
        parseWindow(value);
      } catch (err) {
        return err.message.replace("QUIET_HOURS", "quiet hours");
      }
      control.setting("quietHours", value.toLowerCase() === "off" ? "off" : value);
      return value.toLowerCase() === "off" ? "Quiet hours turned off." : `Quiet hours set to ${value}. Replies due then are sent after it ends.`;
    }
    case "limit": {
      const limit = Number(value);
      if (!/^\d+$/.test(value)) return 'Say a number, e.g. "greeter limit 40" (0 = no limit).';
      control.setting("dailyLimit", limit);
      return limit === 0 ? "Daily limit removed." : `Daily limit set to ${limit} automatic replies.`;
    }
    case "delay": {
      const match = /^(\d+)\s*-\s*(\d+)$/.exec(value);
      if (!match) return 'Say the range in seconds, e.g. "greeter delay 15-300".';
      const [min, max] = [Number(match[1]), Number(match[2])];
      if (min > max) return "The first number must not be larger than the second.";
      if (max > 6 * 3600) return "The longest wait can be at most 21600 seconds (6 hours).";
      control.setting("delaySeconds", { min, max });
      return `Replies now wait a random ${min}s to ${max}s.`;
    }
    case "summary": {
      if (!value) return 'Say a time, e.g. "greeter summary 21:30", or "greeter summary off".';
      if (value.toLowerCase() !== "off") {
        try {
          parseClock(value);
        } catch (err) {
          return err.message;
        }
      }
      control.setting("summaryTime", value.toLowerCase() === "off" ? "off" : value);
      return value.toLowerCase() === "off" ? "Daily summary turned off." : `Daily summary will come at ${value}.`;
    }
    case "only": {
      if (!value) return 'Say which occasions, e.g. "greeter only diwali,holi,birthday", or "greeter only all".';
      if (value.toLowerCase() === "all") {
        control.setting("occasions", []);
        return "Answering greetings for all festivals and birthdays.";
      }
      const occasions = value.split(",").map(normaliseOccasion).filter(Boolean);
      control.setting("occasions", occasions);
      return `Only answering: ${occasions.join(", ")}.`;
    }
    case "reset": {
      const names = { quiet: "quietHours", limit: "dailyLimit", delay: "delaySeconds", summary: "summaryTime", only: "occasions" };
      const key = names[(rest[0] || "").toLowerCase()];
      if (!key) return `Say which setting to reset: ${Object.keys(names).join(", ")}.`;
      control.setting(key, undefined);
      return `${rest[0].toLowerCase()} is back to the .env value.`;
    }
    case "settings":
      return info.settings ? info.settings() : "Settings are shown by the running agent.";
    default:
      return HELP;
  }
}

/** Matches a WhatsApp control message such as "greeter pause" or "Greeter close add Mom". */
export function parseChatCommand(text) {
  const match = /^\s*greeter(?:\s+(.*))?$/is.exec(text || "");
  if (!match) return null;
  return (match[1] || "help").trim().split(/\s+/);
}
