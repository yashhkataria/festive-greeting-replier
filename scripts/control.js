// Kill switch and model switcher from the terminal. Works whether or not the
// agent is running; a running agent applies it within 15 seconds.
//   npm run pause | npm run resume | npm run status | npm run model -- haiku
import path from "node:path";
import { ControlStore, runCommand } from "../src/control.js";

const dataDir = path.resolve(process.env.DATA_DIR || ".data");
const control = new ControlStore(path.join(dataDir, "control.json"), process.env.AI_MODEL || "local");
console.log(runCommand(control, process.argv.slice(2)));
