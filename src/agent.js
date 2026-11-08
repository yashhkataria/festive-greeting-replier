// Decides what to do with each incoming WhatsApp message. Kept free of
// WhatsApp/Claude imports so it can be tested with fakes. Replies are not sent
// here: they go into the pending queue and scheduler.js sends them.
import fs from "node:fs";
import { readJson, writeJson } from "./jsonfile.js";
import { endOfQuiet, localParts } from "./time.js";

const TEXT_TYPES = new Set(["chat"]);
const IMAGE_TYPES = new Set(["image", "sticker"]);
const CAPTION_ONLY_TYPES = new Set(["video", "document"]);

/**
 * Remembers which greetings have been answered so each person gets one reply
 * per occasion per year, and never two auto-replies within the cooldown.
 * Shape on disk: { "<chat>|<sender>": { last: ISO, occasions: { "<occasion>|<year>": ISO } } }
 */
export class RepliedStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = readJson(filePath, {});
  }

  hasOccasion(person, occasion, year) {
    return Boolean(this.data[person]?.occasions?.[`${occasion}|${year}`]);
  }

  lastReplyAt(person) {
    const last = this.data[person]?.last;
    return last ? Date.parse(last) : 0;
  }

  add(person, occasion, year, at = new Date()) {
    const entry = (this.data[person] ??= { last: null, occasions: {} });
    entry.last = at.toISOString();
    entry.occasions[`${occasion}|${year}`] = at.toISOString();
    writeJson(this.filePath, this.data);
  }
}

/**
 * Handles each incoming message: decides whether it is a greeting worth
 * answering and, if so, schedules the reply (sent later by the scheduler).
 * @param {object} deps
 * @param {(input: object, options: { model: string }) => Promise<{isGreeting: boolean, occasion: string, reply: string}>} deps.classify
 * @param {RepliedStore} deps.store
 * @param {import("./queue.js").PendingQueue} deps.queue
 * @param {import("./activity.js").ActivityLog} deps.activity
 * @param {{ get: () => { paused: boolean, model: string } }} deps.control  kill switch and current model
 * @param {(text: string) => Promise<void>} deps.notifySelf  sends a note to your "Message yourself" chat
 * @param {object} deps.config  see index.js; ignoreList and closeList are () => string[], re-read on every message.
 * @param {() => number} [deps.now]  epoch milliseconds
 * @param {() => number} [deps.random]
 */
export function createHandler({ classify, store, queue, activity, control, notifySelf, config, now = Date.now, random = Math.random, log = console }) {
  const allowed = new Set(config.occasions || []);
  // Messages from the same person are handled one at a time, so two quick
  // greetings (say, a text and an image) never produce two replies.
  const chains = new Map();

  async function process(msg) {
    // Broadcast-list messages from friends arrive as normal chats and are kept; status updates are not.
    if (msg.fromMe || msg.isStatus || msg.from === "status@broadcast") return "ignored:own-or-status";
    if (msg.from?.endsWith("@newsletter") || msg.from?.endsWith("@broadcast")) return "ignored:channel";
    // Group chats are never handled: one message in a group would otherwise mean many replies.
    if (msg.from?.endsWith("@g.us")) return "ignored:group";
    if (control.get().paused) return "ignored:paused";

    // Who sent it. Checked before the message is looked at; if the sender
    // can't be identified, skip it.
    let contact;
    try {
      contact = await msg.getContact();
    } catch (err) {
      log.warn(`[agent] could not look up sender of ${msg.id?._serialized}: ${err.message}`);
      return "ignored:unknown-sender";
    }
    if (!contact) return "ignored:unknown-sender";
    if (matchesContactList(contact, config.ignoreList())) return "ignored:on-ignore-list";
    if (!contact.isMyContact && !config.replyToUnknown) return "ignored:not-a-saved-contact";

    const ageSeconds = now() / 1000 - msg.timestamp;
    if (!(ageSeconds <= config.maxMessageAgeSeconds)) return "ignored:too-old";

    const chat = await msg.getChat();
    if (chat.isGroup) return "ignored:group";

    const senderId = msg.from;
    const person = `${chat.id._serialized}|${senderId}`;
    if (queue.hasPerson(person)) return "ignored:reply-already-scheduled";
    if (now() - store.lastReplyAt(person) < config.cooldownHours * 3600 * 1000) return "ignored:cooldown";

    let text = "";
    let image;
    if (TEXT_TYPES.has(msg.type)) {
      text = msg.body;
    } else if (IMAGE_TYPES.has(msg.type)) {
      text = msg.type === "image" ? msg.body : "";
      try {
        image = await msg.downloadMedia();
      } catch (err) {
        log.warn(`[agent] could not download media: ${err.message}`);
      }
    } else if (CAPTION_ONLY_TYPES.has(msg.type)) {
      text = msg.body;
    } else {
      return "ignored:unsupported-type";
    }
    if (!text?.trim() && !image) return "ignored:empty";

    const senderName = contact.pushname || contact.name || msg._data?.notifyName || "";
    const model = control.get().model;
    const result = await classify({ text, senderName, image: image || undefined }, { model });
    if (!result.isGreeting) return "not-a-greeting";
    if (allowed.size > 0 && !allowed.has(result.occasion)) return `ignored:occasion-not-enabled(${result.occasion})`;

    const { year } = localParts(msg.timestamp * 1000, config.timeZone);
    if (store.hasOccasion(person, result.occasion, year)) return "ignored:already-replied";

    const who = contact.name || senderName || contact.number || senderId;
    const today = localParts(now(), config.timeZone).date;

    // Close people: you get a reminder to answer them personally instead.
    if (matchesContactList(contact, config.closeList())) {
      const what = text?.trim() ? `"${truncate(text.trim(), 300)}"` : "(sent an image)";
      const note = `🤖 ${who} wished you for ${result.occasion}: ${what}\nThey're on your close people list, so reply to them yourself.`;
      if (config.dryRun) {
        log.log(`[dry-run] would remind you: ${note}`);
      } else {
        await notifySelf(note);
        activity.record(today, "reminded", { who, occasion: result.occasion });
      }
      store.add(person, result.occasion, year, new Date(now()));
      return config.dryRun ? "reminded:dry-run" : "reminded";
    }

    if (config.dailyLimit > 0 && activity.count(today, "replied") + queue.size >= config.dailyLimit) {
      activity.record(today, "capped", { who, occasion: result.occasion });
      if (activity.claimLimitNotice(today)) {
        await notifySelf(`🤖 Daily limit of ${config.dailyLimit} automatic replies reached. Other greetings today are left for you.`);
      }
      return "ignored:daily-limit";
    }

    if (config.dryRun) {
      log.log(`[dry-run] ${result.occasion} greeting from ${who}; would reply: ${result.reply}`);
      store.add(person, result.occasion, year, new Date(now()));
      return "replied:dry-run";
    }

    const sendAt = planSendTime(now(), config, random);
    queue.add({
      id: `${person}|${result.occasion}|${msg.timestamp}`,
      chatId: chat.id._serialized,
      person,
      who,
      occasion: result.occasion,
      year,
      reply: result.reply,
      msgTimestamp: msg.timestamp,
      sendAt,
    });
    log.log(`[agent] ${result.occasion} greeting from ${who}; reply scheduled for ${new Date(sendAt).toISOString()}`);
    return "scheduled";
  }

  return function handle(msg) {
    const chainKey = msg.from;
    const previous = chains.get(chainKey) || Promise.resolve();
    const current = previous
      .then(() => process(msg))
      .catch((err) => {
        log.error(`[agent] failed on message ${msg.id?._serialized}: ${err.stack || err.message}`);
        return "error";
      });
    chains.set(chainKey, current);
    current.finally(() => {
      if (chains.get(chainKey) === current) chains.delete(chainKey);
    });
    return current;
  };
}

/**
 * When to send a reply: a random wait between the configured bounds, so
 * replies don't follow a pattern. If that lands in quiet hours, it moves to a
 * random moment in the first 45 minutes after they end.
 */
export function planSendTime(nowMs, config, random = Math.random) {
  const wanted = nowMs + config.minDelayMs + random() * (config.maxDelayMs - config.minDelayMs);
  const allowedAt = endOfQuiet(wanted, config.quietHours, config.timeZone);
  return allowedAt === wanted ? Math.round(wanted) : allowedAt + Math.round(random() * 45 * 60 * 1000);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * True if the contact is in a contact list (ignore list or close people).
 * Entries are phone numbers (any format; a number without country code matches
 * its last digits) or the name exactly as saved in your phone (case-insensitive).
 */
export function matchesContactList(contact, entries) {
  const numbers = [contact.number, contact.id?.user].map((n) => (n || "").replace(/\D/g, "")).filter(Boolean);
  const savedName = (contact.name || "").trim().toLowerCase();
  return entries.some((entry) => {
    if (/\p{L}/u.test(entry)) return savedName !== "" && entry.trim().toLowerCase() === savedName;
    const digits = entry.replace(/\D/g, "");
    return digits.length >= 8 && numbers.some((n) => n.endsWith(digits));
  });
}

/** Reads a contact-list file: one number or saved name per line, # for comments. Missing file = empty list. */
export function loadContactList(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}
