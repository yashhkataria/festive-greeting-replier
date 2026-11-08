// The kill switch and model switcher. State lives in one small JSON file that
// is re-read on every use, so changes from the CLI or from your phone apply to
// the running agent immediately and survive restarts.
import fs from "node:fs";
import path from "node:path";

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/** Turns "sonnet" or "claude-sonnet-5-5" into a model id; returns null for anything else. */
export function resolveModel(name) {
  const key = (name || "").trim().toLowerCase();
  if (MODELS[key]) return MODELS[key];
  return Object.values(MODELS).includes(key) ? key : null;
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

  /** @returns {{ paused: boolean, model: string }} */
  get() {
    let state = this.memory;
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      } catch {
        // A damaged file must never switch the agent on: treat it as paused.
        return { paused: true, model: this.defaultModel };
      }
    }
    return {
      paused: state.paused === true,
      model: resolveModel(state.model) || this.defaultModel,
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
}

const HELP = `Commands:
greeter pause - stop replying (kill switch)
greeter resume - start replying again
greeter status - show current state
greeter model opus|sonnet|haiku - switch the Claude model`;

/**
 * Runs one control command and returns the text to show. Used by both the CLI
 * (`node scripts/control.js pause`) and the WhatsApp "greeter ..." commands.
 * @param {ControlStore} control
 * @param {string[]} args  e.g. ["model", "haiku"]
 * @param {() => string} [describe]  extra status details (queue, today's counts) from the running agent
 */
export function runCommand(control, args, describe) {
  const [command = "status", value] = args.map((a) => a.toLowerCase());
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
      const extra = describe ? ` ${describe()}` : "";
      return `Greeter is ${paused ? "PAUSED" : "ON"}. Model: ${model}.${extra}`;
    }
    case "model": {
      const model = resolveModel(value);
      if (!model) return `Unknown model "${value || ""}". Choose: ${Object.keys(MODELS).join(", ")}.`;
      control.set({ model });
      return `Model switched to ${model}.`;
    }
    default:
      return HELP;
  }
}

/** Matches a WhatsApp control message such as "greeter pause" or "Greeter model haiku". */
export function parseChatCommand(text) {
  const match = /^\s*greeter(?:\s+(.*))?$/i.exec(text || "");
  if (!match) return null;
  return (match[1] || "help").trim().split(/\s+/);
}
