// Connects to WhatsApp (via WhatsApp Web) and auto-replies to festival
// greetings and birthday wishes from your saved contacts.
import fs from "node:fs";
import path from "node:path";
import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { classifyAndReply, normaliseOccasion } from "./classifier.js";
import { createHandler, loadContactList, RepliedStore } from "./agent.js";
import { ControlStore, parseChatCommand, runCommand } from "./control.js";
import { PendingQueue } from "./queue.js";
import { ActivityLog } from "./activity.js";
import { createScheduler } from "./scheduler.js";
import { checkTimeZone, localParts, parseClock, parseWindow } from "./time.js";

const { Client, LocalAuth } = pkg;
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const env = process.env;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function numberSetting(name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) fail(`${name} must be a number of 0 or more (got "${env[name]}").`);
  return value;
}

/** A contact list from a file plus an optional comma-separated env var, re-read on every use. */
function contactList(fileVar, defaultFile, listVar) {
  const filePath = path.resolve(env[fileVar] || defaultFile);
  const fromEnv = (env[listVar] || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return () => [...loadContactList(filePath), ...fromEnv];
}

let config;
try {
  config = {
    dryRun: env.DRY_RUN === "1",
    // Only people saved in your phone's contacts get replies, unless this is set.
    replyToUnknown: env.REPLY_TO_UNKNOWN === "1",
    // People whose messages are never looked at or answered.
    ignoreList: contactList("IGNORE_FILE", "ignore-contacts.txt", "IGNORE_CONTACTS"),
    // People you want to answer yourself: you get a reminder instead of an automatic reply.
    closeList: contactList("CLOSE_CONTACTS_FILE", "close-contacts.txt", "CLOSE_CONTACTS"),
    // Ignore anything older than this, e.g. backlog delivered after being offline for days.
    maxMessageAgeSeconds: numberSetting("MAX_MESSAGE_AGE_HOURS", 24) * 3600,
    // Never auto-reply to the same person twice within this many hours.
    cooldownHours: numberSetting("COOLDOWN_HOURS", 12),
    // Comma-separated list such as "diwali,holi,birthday"; empty means every festival and birthdays.
    occasions: (env.OCCASIONS || "").split(",").map(normaliseOccasion).filter(Boolean),
    // Random wait before each reply, so replies don't follow a pattern.
    minDelayMs: numberSetting("MIN_DELAY_SECONDS", 15) * 1000,
    maxDelayMs: numberSetting("MAX_DELAY_SECONDS", 300) * 1000,
    // At most this many automatic replies per day; 0 means no limit.
    dailyLimit: numberSetting("DAILY_REPLY_LIMIT", 40),
    // Your local time zone, for quiet hours, the summary and "today".
    timeZone: env.TIMEZONE || "Asia/Kolkata",
    // No replies are sent in this window; they go out shortly after it ends.
    quietHours: parseWindow(env.QUIET_HOURS ?? "23:00-08:00"),
    // When the daily summary is sent to your "Message yourself" chat; "off" disables it.
    summaryTime: /^\s*off\s*$/i.test(env.SUMMARY_TIME || "") ? null : parseClock(env.SUMMARY_TIME || "21:30"),
  };
  checkTimeZone(config.timeZone);
} catch (err) {
  fail(err.message);
}
if (config.minDelayMs > config.maxDelayMs) fail("MIN_DELAY_SECONDS must not be larger than MAX_DELAY_SECONDS.");
if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) fail("Set ANTHROPIC_API_KEY before starting (see README).");

const dataDir = path.resolve(env.DATA_DIR || ".data");
const sessionDir = path.join(dataDir, "session");
const store = new RepliedStore(path.join(dataDir, "replied.json"));
const queue = new PendingQueue(path.join(dataDir, "pending.json"));
const activity = new ActivityLog(path.join(dataDir, "activity.json"));
// Kill switch + model switcher; CLAUDE_MODEL only sets the starting model.
const control = new ControlStore(path.join(dataDir, "control.json"), env.CLAUDE_MODEL || "opus");

// In a container, a restart can leave Chrome's profile lock behind, which would
// stop Chrome from starting. Only one agent runs per container, so it is safe to clear.
if (env.RUNNING_IN_CONTAINER === "1") {
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    fs.rmSync(path.join(sessionDir, "session", lock), { force: true });
  }
}

const pairPhoneNumber = (env.PAIR_PHONE_NUMBER || "").replace(/\D/g, "");
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionDir }),
  puppeteer: {
    headless: true,
    // Use CHROME_PATH, else an installed Google Chrome, else puppeteer's default.
    executablePath: env.CHROME_PATH || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : undefined),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
  // On a server, link with a code typed into your phone instead of scanning a QR code.
  ...(pairPhoneNumber ? { pairWithPhoneNumber: { phoneNumber: pairPhoneNumber, showNotification: true } } : {}),
});

async function notifySelf(text) {
  await client.sendMessage(client.info.wid._serialized, text, { sendSeen: false });
}

const handle = createHandler({ classify: classifyAndReply, store, queue, activity, control, notifySelf, config });
const scheduler = createScheduler({
  queue,
  store,
  activity,
  control,
  getChat: (chatId) => client.getChatById(chatId),
  notifySelf,
  config,
});

function describe() {
  const today = localParts(Date.now(), config.timeZone).date;
  const next = queue.jobs.length ? Math.min(...queue.jobs.map((job) => job.sendAt)) : null;
  return (
    `Today: ${activity.count(today, "replied")} replied` +
    (config.dailyLimit ? ` (limit ${config.dailyLimit})` : "") +
    `, ${activity.count(today, "reminded")} reminders. Scheduled: ${queue.size}` +
    (next ? `, next at ${new Date(next).toLocaleTimeString("en-GB", { timeZone: config.timeZone, hour: "2-digit", minute: "2-digit" })}` : "") +
    "."
  );
}

client.on("qr", (qr) => {
  console.log("Scan this QR code in WhatsApp > Settings > Linked devices > Link a device:");
  qrcode.generate(qr, { small: true });
});
client.on("code", (code) => {
  console.log(
    `Pairing code: ${code.slice(0, 4)}-${code.slice(4)}\n` +
      "On your phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then enter this code.",
  );
});
client.on("authenticated", () => console.log("Authenticated."));
client.on("auth_failure", (msg) => fail(`Authentication failed: ${msg}`));

let schedulerTimer;
client.on("ready", () => {
  const scope = config.occasions.length ? config.occasions.join(", ") : "all festivals and birthdays";
  const { paused, model } = control.get();
  console.log(
    `Ready. Watching for: ${scope}. Model: ${model}.` +
      (paused ? " PAUSED (kill switch is on): nothing will be sent until resumed." : "") +
      (config.dryRun ? " DRY RUN: nothing will be sent." : "") +
      (config.replyToUnknown ? " Unknown numbers get replies too." : " Only saved contacts get replies.") +
      ` ${config.ignoreList().length} ignored, ${config.closeList().length} close contact(s).` +
      ` ${queue.size} reply(ies) scheduled.`,
  );
  if (!schedulerTimer) {
    schedulerTimer = setInterval(() => scheduler.tick().catch((err) => console.error("[scheduler]", err)), 15_000);
    scheduler.tick().catch((err) => console.error("[scheduler]", err));
  }
});
client.on("disconnected", (reason) => fail(`Disconnected: ${reason}`));

// "message" fires only for messages received from others, never your own.
client.on("message", (msg) => {
  handle(msg);
});

// Control from your phone: send yourself "greeter pause", "greeter resume",
// "greeter status" or "greeter model haiku". Only your own messages are obeyed;
// the answer always goes to your "Message yourself" chat. Answers start with an
// emoji so they are never mistaken for a new command.
client.on("message_create", async (msg) => {
  if (!msg.fromMe) return;
  const args = parseChatCommand(msg.body);
  if (!args) return;
  try {
    const answer = `🤖 ${runCommand(control, args, describe)}`;
    console.log(`[control] ${args.join(" ")} -> ${answer}`);
    // Apply a pause right away instead of at the next scheduler tick.
    if (control.get().paused) await scheduler.tick();
    await notifySelf(answer);
  } catch (err) {
    console.error(`[control] failed: ${err.message}`);
  }
});

process.on("unhandledRejection", (err) => console.error("[unhandled]", err));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log("Shutting down...");
    clearInterval(schedulerTimer);
    try {
      await client.destroy();
    } finally {
      process.exit(0);
    }
  });
}

// A failed start must exit with an error, so a supervisor (keep-running.js, Docker) restarts it.
client.initialize().catch((err) => fail(`Could not start WhatsApp: ${err.message}`));
