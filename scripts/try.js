// Shows what the agent would decide and reply for a message, without WhatsApp.
//   npm run try -- "Happy Diwali bhai!"
//   npm run try -- --image photo.jpg "caption"     (an image greeting)
//   npm run try -- --model haiku "Eid Mubarak"     (paid Claude model, needs ANTHROPIC_API_KEY)
import fs from "node:fs";
import path from "node:path";
import { classifyAndReply, LOCAL } from "../src/classifier.js";
import { modelLabel, resolveModel } from "../src/control.js";

const args = process.argv.slice(2);
let model = resolveModel(process.env.AI_MODEL || "local") || LOCAL;
let image;
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model") model = resolveModel(args[++i]) || model;
  else if (args[i] === "--image") {
    const file = args[++i];
    const ext = path.extname(file).toLowerCase();
    const mimetype = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    image = { mimetype, data: fs.readFileSync(file).toString("base64") };
  } else words.push(args[i]);
}
const text = words.join(" ");
if (!text && !image) {
  console.log('Usage: npm run try -- "Happy Diwali bhai!"');
  process.exit(1);
}

const started = Date.now();
const result = await classifyAndReply({ text, senderName: process.env.TRY_SENDER || "", image }, { model });
console.log(`Model: ${modelLabel(model)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
console.log(result.isGreeting ? `Greeting: ${result.occasion}\nReply: ${result.reply}` : "Not a greeting: no reply.");
