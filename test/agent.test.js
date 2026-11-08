import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler, loadContactList, matchesContactList, planSendTime, RepliedStore } from "../src/agent.js";
import { buildContent, normaliseOccasion } from "../src/classifier.js";
import { ControlStore, parseChatCommand, resolveModel, runCommand } from "../src/control.js";
import { PendingQueue } from "../src/queue.js";
import { ActivityLog, formatSummary } from "../src/activity.js";
import { createScheduler } from "../src/scheduler.js";
import { endOfQuiet, isInWindow, localParts, parseClock, parseWindow } from "../src/time.js";

// 15:30 in India: outside the default quiet hours.
const NOW = Date.parse("2026-11-08T10:00:00Z");
const nowSeconds = NOW / 1000;
const TODAY = "2026-11-08";

function fakeChat({ isGroup = false, id = "911234567890@c.us" } = {}) {
  return {
    isGroup,
    id: { _serialized: id },
    sent: [],
    history: [],
    async fetchMessages() {
      return this.history;
    },
    async sendMessage(text) {
      this.sent.push(text);
    },
    async sendStateTyping() {},
    async clearState() {},
  };
}

const friend = { pushname: "Rahul", name: "Rahul Sharma", number: "911234567890", id: { user: "911234567890" }, isMyContact: true };
const stranger = { pushname: "Promo", name: undefined, number: "919000000000", id: { user: "919000000000" }, isMyContact: false };

function fakeMsg(overrides = {}) {
  const chat = overrides.chat || fakeChat();
  return {
    id: { _serialized: Math.random().toString(36) },
    from: chat.id._serialized,
    fromMe: false,
    isStatus: false,
    type: "chat",
    body: "Happy Diwali!",
    timestamp: nowSeconds - 60,
    async getChat() {
      return chat;
    },
    async getContact() {
      return friend;
    },
    async downloadMedia() {
      return { mimetype: "image/jpeg", data: "AAAA" };
    },
    chat,
    ...overrides,
  };
}

const baseConfig = {
  dryRun: false,
  replyToUnknown: false,
  ignoreList: () => [],
  closeList: () => [],
  maxMessageAgeSeconds: 24 * 3600,
  cooldownHours: 12,
  occasions: [],
  minDelayMs: 15_000,
  maxDelayMs: 300_000,
  dailyLimit: 40,
  timeZone: "Asia/Kolkata",
  quietHours: parseWindow("23:00-08:00"),
  summaryTime: parseClock("21:30"),
};

const quiet = { log() {}, warn() {}, error() {} };

/** Handler + scheduler wired to fakes. `clock.now` can be moved forward. */
function setup({ config = {}, result = { isGreeting: true, occasion: "diwali", reply: "Happy Diwali to you too! 🪔" }, random = Math.random } = {}) {
  const clock = { now: NOW };
  const now = () => clock.now;
  const calls = [];
  const models = [];
  const notes = [];
  const chats = new Map();
  const store = new RepliedStore(null);
  const queue = new PendingQueue(null);
  const activity = new ActivityLog(null);
  const control = new ControlStore(null);
  const fullConfig = { ...baseConfig, ...config };
  const notifySelf = async (text) => {
    notes.push(text);
  };
  const handler = createHandler({
    classify: async (input, options) => {
      calls.push(input);
      models.push(options.model);
      return typeof result === "function" ? result(input) : result;
    },
    store,
    queue,
    activity,
    control,
    notifySelf,
    config: fullConfig,
    now,
    random,
    log: quiet,
  });
  const scheduler = createScheduler({
    queue,
    store,
    activity,
    control,
    getChat: async (chatId) => chats.get(chatId),
    notifySelf,
    config: fullConfig,
    now,
    sleep: async () => {},
    log: quiet,
  });
  /** Handles a message, remembering its chat so the scheduler can find it. */
  const handle = (msg) => {
    chats.set(msg.chat.id._serialized, msg.chat);
    return handler(msg);
  };
  /** Moves the clock past every scheduled reply and lets the scheduler run. */
  const flush = async () => {
    const latest = Math.max(clock.now, ...queue.jobs.map((job) => job.sendAt));
    clock.now = latest;
    await scheduler.tick();
  };
  return { handle, scheduler, flush, clock, calls, models, notes, store, queue, activity, control };
}

// --- who gets a reply ---

test("a Diwali greeting is scheduled, then sent by the scheduler", async () => {
  const ctx = setup();
  const msg = fakeMsg();
  assert.equal(await ctx.handle(msg), "scheduled");
  assert.deepEqual(msg.chat.sent, []);
  await ctx.flush();
  assert.deepEqual(msg.chat.sent, ["Happy Diwali to you too! 🪔"]);
  assert.equal(ctx.queue.size, 0);
  assert.equal(ctx.activity.count(TODAY, "replied"), 1);
});

test("does not reply to non-greetings", async () => {
  const ctx = setup({ result: { isGreeting: false, occasion: "", reply: "" } });
  assert.equal(await ctx.handle(fakeMsg({ body: "Are you coming for the Diwali party?" })), "not-a-greeting");
  assert.equal(ctx.queue.size, 0);
});

test("ignores own messages, status updates and channels without calling Claude", async () => {
  const ctx = setup();
  assert.equal(await ctx.handle(fakeMsg({ fromMe: true })), "ignored:own-or-status");
  assert.equal(await ctx.handle(fakeMsg({ isStatus: true })), "ignored:own-or-status");
  assert.equal(await ctx.handle(fakeMsg({ from: "status@broadcast" })), "ignored:own-or-status");
  assert.equal(await ctx.handle(fakeMsg({ from: "123@newsletter" })), "ignored:channel");
  assert.equal(ctx.calls.length, 0);
});

test("ignores old messages", async () => {
  const ctx = setup();
  assert.equal(await ctx.handle(fakeMsg({ timestamp: nowSeconds - 25 * 3600 })), "ignored:too-old");
  assert.equal(ctx.calls.length, 0);
});

test("group messages are dropped before anything is looked up", async () => {
  const touched = [];
  const ctx = setup();
  const groupChat = fakeChat({ isGroup: true, id: "family@g.us" });
  const msg = fakeMsg({
    chat: groupChat,
    from: "family@g.us",
    author: "91999@c.us",
    async getContact() {
      touched.push("contact");
    },
    async getChat() {
      touched.push("chat");
    },
  });
  assert.equal(await ctx.handle(msg), "ignored:group");
  assert.deepEqual(touched, []);
  assert.equal(ctx.calls.length, 0);
});

test("a chat that turns out to be a group is still never answered", async () => {
  const ctx = setup();
  assert.equal(await ctx.handle(fakeMsg({ chat: fakeChat({ isGroup: true, id: "1203630@c.us" }) })), "ignored:group");
  assert.equal(ctx.calls.length, 0);
});

test("unknown numbers are skipped before Claude sees the message", async () => {
  const ctx = setup();
  assert.equal(await ctx.handle(fakeMsg({ getContact: async () => stranger })), "ignored:not-a-saved-contact");
  assert.equal(ctx.calls.length, 0);
});

test("REPLY_TO_UNKNOWN lets unknown numbers through", async () => {
  const ctx = setup({ config: { replyToUnknown: true } });
  assert.equal(await ctx.handle(fakeMsg({ getContact: async () => stranger })), "scheduled");
});

test("ignore-listed contacts are dropped before the chat or message is touched", async () => {
  const touched = [];
  const ctx = setup({ config: { ignoreList: () => ["+91 12345 67890"] } });
  const msg = fakeMsg({
    async getChat() {
      touched.push("chat");
    },
    async downloadMedia() {
      touched.push("media");
    },
  });
  assert.equal(await ctx.handle(msg), "ignored:on-ignore-list");
  assert.deepEqual(touched, []);
  assert.equal(ctx.calls.length, 0);
});

test("ignore list also matches by saved name", async () => {
  const ctx = setup({ config: { ignoreList: () => ["rahul sharma"] } });
  assert.equal(await ctx.handle(fakeMsg()), "ignored:on-ignore-list");
});

test("if the sender cannot be looked up, nothing is read or sent", async () => {
  const ctx = setup();
  const msg = fakeMsg({
    async getContact() {
      throw new Error("lookup failed");
    },
  });
  assert.equal(await ctx.handle(msg), "ignored:unknown-sender");
  assert.equal(ctx.calls.length, 0);
});

test("images and stickers are passed to Claude; unsupported types are skipped", async () => {
  const ctx = setup();
  await ctx.handle(fakeMsg({ type: "sticker", body: "" }));
  assert.equal(ctx.calls[0].image.mimetype, "image/jpeg");
  const other = fakeChat({ id: "91555@c.us" });
  assert.equal(await ctx.handle(fakeMsg({ chat: other, type: "ptt", body: "" })), "ignored:unsupported-type");
  assert.equal(ctx.calls.length, 1);
});

test("OCCASIONS allowlist limits which greetings get replies", async () => {
  const ctx = setup({ config: { occasions: ["birthday"] } });
  assert.equal(await ctx.handle(fakeMsg()), "ignored:occasion-not-enabled(diwali)");
});

test("dry run schedules and sends nothing", async () => {
  const ctx = setup({ config: { dryRun: true } });
  const msg = fakeMsg();
  assert.equal(await ctx.handle(msg), "replied:dry-run");
  assert.equal(ctx.queue.size, 0);
  await ctx.flush();
  assert.deepEqual(msg.chat.sent, []);
});

test("a Claude error schedules nothing, and the next greeting still works", async () => {
  let fail = true;
  const ctx = setup({
    result: () => {
      if (fail) throw new Error("network down");
      return { isGreeting: true, occasion: "diwali", reply: "Happy Diwali!" };
    },
  });
  const chat = fakeChat();
  assert.equal(await ctx.handle(fakeMsg({ chat })), "error");
  fail = false;
  assert.equal(await ctx.handle(fakeMsg({ chat })), "scheduled");
});

// --- no repeats ---

test("a text and an image arriving together produce one reply", async () => {
  const ctx = setup();
  const chat = fakeChat();
  const results = await Promise.all([ctx.handle(fakeMsg({ chat })), ctx.handle(fakeMsg({ chat, type: "image", body: "" }))]);
  assert.deepEqual(results, ["scheduled", "ignored:reply-already-scheduled"]);
  await ctx.flush();
  assert.equal(chat.sent.length, 1);
});

test("cooldown blocks a second reply to the same person for a different occasion", async () => {
  const ctx = setup({
    result: (input) =>
      input.text.includes("birthday")
        ? { isGreeting: true, occasion: "birthday", reply: "Thank you so much!" }
        : { isGreeting: true, occasion: "diwali", reply: "Happy Diwali!" },
  });
  const chat = fakeChat();
  await ctx.handle(fakeMsg({ chat }));
  await ctx.flush();
  const sentAt = ctx.clock.now;
  assert.equal(await ctx.handle(fakeMsg({ chat, body: "happy birthday!", timestamp: sentAt / 1000 })), "ignored:cooldown");
  ctx.clock.now = sentAt + 13 * 3600 * 1000;
  assert.equal(await ctx.handle(fakeMsg({ chat, body: "happy birthday!", timestamp: ctx.clock.now / 1000 })), "scheduled");
  await ctx.flush();
  assert.deepEqual(chat.sent, ["Happy Diwali!", "Thank you so much!"]);
});

test("same occasion is answered once per year even after the cooldown", async () => {
  const ctx = setup();
  const chat = fakeChat();
  await ctx.handle(fakeMsg({ chat }));
  await ctx.flush();
  ctx.clock.now += 2 * 24 * 3600 * 1000;
  assert.equal(await ctx.handle(fakeMsg({ chat, timestamp: ctx.clock.now / 1000 })), "ignored:already-replied");
});

// --- 1. daily limit ---

test("daily limit: greetings beyond the limit are left for you, with one notice", async () => {
  const ctx = setup({ config: { dailyLimit: 2 } });
  for (let i = 0; i < 4; i++) {
    await ctx.handle(fakeMsg({ chat: fakeChat({ id: `9100${i}@c.us` }) }));
  }
  assert.equal(ctx.queue.size, 2);
  assert.equal(ctx.activity.count(TODAY, "capped"), 2);
  assert.equal(ctx.notes.filter((n) => n.includes("Daily limit")).length, 1);
  await ctx.flush();
  assert.equal(ctx.activity.count(TODAY, "replied"), 2);
});

test("daily limit is checked again when sending", async () => {
  const ctx = setup({ config: { dailyLimit: 1 } });
  await ctx.handle(fakeMsg({ chat: fakeChat({ id: "91001@c.us" }) }));
  // Something else used up today's limit while this reply waited.
  ctx.activity.record(TODAY, "replied", { who: "x", occasion: "diwali" });
  await ctx.flush();
  assert.equal(ctx.activity.count(TODAY, "replied"), 1);
  assert.equal(ctx.activity.count(TODAY, "capped"), 1);
});

test("daily limit 0 means no limit", async () => {
  const ctx = setup({ config: { dailyLimit: 0 } });
  for (let i = 0; i < 50; i++) await ctx.handle(fakeMsg({ chat: fakeChat({ id: `9200${i}@c.us` }) }));
  assert.equal(ctx.queue.size, 50);
});

// --- 2. random delay and quiet hours ---

test("random wait is 15s to 5min outside quiet hours", () => {
  const waits = Array.from({ length: 200 }, () => planSendTime(NOW, baseConfig) - NOW);
  assert.ok(waits.every((ms) => ms >= 15_000 && ms <= 300_000));
  assert.ok(new Set(waits).size > 150, "waits should vary");
});

test("a greeting during quiet hours is answered 08:00-08:45 the next morning", () => {
  const lateNight = Date.parse("2026-11-08T18:00:00Z"); // 23:30 in India
  for (let i = 0; i < 50; i++) {
    const sendAt = planSendTime(lateNight, baseConfig);
    assert.ok(sendAt >= Date.parse("2026-11-09T02:30:00Z") && sendAt <= Date.parse("2026-11-09T03:15:00Z"), new Date(sendAt).toISOString());
  }
});

test("a wait that runs into quiet hours is moved past them too", () => {
  const justBefore = Date.parse("2026-11-08T17:28:00Z"); // 22:58 in India, wait pushes past 23:00
  const sendAt = planSendTime(justBefore, baseConfig, () => 1);
  assert.ok(sendAt >= Date.parse("2026-11-09T02:30:00Z"));
});

test("quiet hours can be turned off", () => {
  const lateNight = Date.parse("2026-11-08T18:00:00Z");
  const sendAt = planSendTime(lateNight, { ...baseConfig, quietHours: parseWindow("off") }, () => 0);
  assert.equal(sendAt, lateNight + 15_000);
});

test("the scheduler doesn't send before a reply's time", async () => {
  const ctx = setup();
  const msg = fakeMsg();
  await ctx.handle(msg);
  await ctx.scheduler.tick();
  assert.deepEqual(msg.chat.sent, []);
  assert.equal(ctx.queue.size, 1);
});

test("if you reply yourself while the agent waits, it stays quiet", async () => {
  const ctx = setup();
  const chat = fakeChat();
  const msg = fakeMsg({ chat });
  await ctx.handle(msg);
  chat.history = [{ fromMe: true, timestamp: msg.timestamp + 30 }];
  await ctx.flush();
  assert.deepEqual(chat.sent, []);
  assert.equal(ctx.activity.count(TODAY, "you-replied"), 1);
  assert.equal(await ctx.handle(fakeMsg({ chat, timestamp: ctx.clock.now / 1000 })), "ignored:cooldown");
});

test("your older messages in the chat don't stop the reply", async () => {
  const ctx = setup();
  const chat = fakeChat();
  const msg = fakeMsg({ chat });
  chat.history = [{ fromMe: true, timestamp: msg.timestamp - 3600 }];
  await ctx.handle(msg);
  await ctx.flush();
  assert.equal(chat.sent.length, 1);
});

// --- 3. close people ---

test("close people get a reminder to you instead of an automatic reply", async () => {
  const ctx = setup({ config: { closeList: () => ["Rahul Sharma"] } });
  const msg = fakeMsg({ body: "Happy Diwali bhai!" });
  assert.equal(await ctx.handle(msg), "reminded");
  assert.equal(ctx.queue.size, 0);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /^🤖 Rahul Sharma wished you for diwali: "Happy Diwali bhai!"/);
  assert.equal(parseChatCommand(ctx.notes[0]), null);
  await ctx.flush();
  assert.deepEqual(msg.chat.sent, []);
  // Only one reminder per occasion.
  assert.equal(await ctx.handle(fakeMsg({ timestamp: ctx.clock.now / 1000 })), "ignored:cooldown");
});

test("the ignore list wins over the close list", async () => {
  const ctx = setup({ config: { closeList: () => ["Rahul Sharma"], ignoreList: () => ["Rahul Sharma"] } });
  assert.equal(await ctx.handle(fakeMsg()), "ignored:on-ignore-list");
  assert.equal(ctx.notes.length, 0);
});

// --- 4. daily summary ---

test("the daily summary is sent once, at the set time, and only if something happened", async () => {
  const ctx = setup({ config: { closeList: () => ["Mom"] } });
  await ctx.handle(fakeMsg());
  await ctx.flush();
  await ctx.scheduler.tick();
  assert.equal(ctx.notes.length, 0, "not before 21:30");

  ctx.clock.now = Date.parse("2026-11-08T16:05:00Z"); // 21:35 in India
  await ctx.scheduler.tick();
  await ctx.scheduler.tick();
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /Greetings summary for 2026-11-08/);
  assert.match(ctx.notes[0], /Replied to 1:\n• Rahul Sharma \(diwali\)/);

  ctx.clock.now = Date.parse("2026-11-09T16:05:00Z"); // next evening, nothing happened
  await ctx.scheduler.tick();
  assert.equal(ctx.notes.length, 1);
});

test("summary formatting covers every kind of event", () => {
  const events = [
    { type: "replied", who: "A", occasion: "diwali" },
    { type: "reminded", who: "Mom", occasion: "diwali" },
    { type: "you-replied", who: "B", occasion: "diwali" },
    { type: "capped", who: "C", occasion: "diwali" },
    { type: "cancelled", who: "D", occasion: "diwali" },
  ];
  const text = formatSummary(TODAY, events, 2);
  for (const part of ["Replied to 1", "Waiting for your personal reply (1)", "You replied yourself", "daily limit was reached: 1", "kill switch: 1", "Still scheduled to send: 2"]) {
    assert.ok(text.includes(part), part);
  }
  assert.equal(formatSummary(TODAY, [], 0), null);
});

// --- 5. restarts ---

test("scheduled replies survive a restart and are sent afterwards", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-"));
  const file = path.join(dir, "pending.json");
  new PendingQueue(file).add({ id: "a", chatId: "91@c.us", person: "91@c.us|91@c.us", who: "Rahul", occasion: "diwali", year: 2026, reply: "Hi!", msgTimestamp: nowSeconds, sendAt: NOW + 60_000 });

  const reloaded = new PendingQueue(file);
  assert.equal(reloaded.size, 1);
  const chat = fakeChat({ id: "91@c.us" });
  const scheduler = createScheduler({
    queue: reloaded,
    store: new RepliedStore(null),
    activity: new ActivityLog(null),
    control: new ControlStore(null),
    getChat: async () => chat,
    notifySelf: async () => {},
    config: baseConfig,
    now: () => NOW + 120_000,
    sleep: async () => {},
    log: quiet,
  });
  await scheduler.tick();
  assert.deepEqual(chat.sent, ["Hi!"]);
  assert.equal(new PendingQueue(file).size, 0);
});

test("a reply that waited too long (agent was down) is dropped, not sent late", async () => {
  const ctx = setup();
  const msg = fakeMsg();
  await ctx.handle(msg);
  ctx.clock.now = NOW + 25 * 3600 * 1000;
  await ctx.scheduler.tick();
  assert.deepEqual(msg.chat.sent, []);
  assert.equal(ctx.queue.size, 0);
});

test("a failed send is not retried, so it can never be sent twice", async () => {
  const ctx = setup();
  const chat = fakeChat();
  chat.sendMessage = async () => {
    throw new Error("WhatsApp hiccup");
  };
  await ctx.handle(fakeMsg({ chat }));
  await ctx.flush();
  assert.equal(ctx.queue.size, 0);
  assert.equal(ctx.activity.count(TODAY, "replied"), 0);
});

test("stores survive restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stores-"));
  new RepliedStore(path.join(dir, "replied.json")).add("chat|me", "diwali", 2026, new Date(NOW));
  const replied = new RepliedStore(path.join(dir, "replied.json"));
  assert.equal(replied.hasOccasion("chat|me", "diwali", 2026), true);
  assert.equal(replied.lastReplyAt("chat|me"), NOW);

  const log = new ActivityLog(path.join(dir, "activity.json"));
  log.record(TODAY, "replied", { who: "A", occasion: "diwali" });
  log.markSummarySent(TODAY);
  const reloaded = new ActivityLog(path.join(dir, "activity.json"));
  assert.equal(reloaded.count(TODAY, "replied"), 1);
  assert.equal(reloaded.summarySentFor, TODAY);
});

test("activity log keeps only the last 7 days", () => {
  const log = new ActivityLog(null);
  for (let d = 1; d <= 10; d++) log.record(`2026-11-${String(d).padStart(2, "0")}`, "replied");
  assert.deepEqual(Object.keys(log.days).sort()[0], "2026-11-04");
  assert.equal(Object.keys(log.days).length, 7);
});

// --- kill switch and model switcher ---

test("kill switch: a paused agent does not read or answer anything", async () => {
  const ctx = setup();
  ctx.control.set({ paused: true });
  assert.equal(await ctx.handle(fakeMsg()), "ignored:paused");
  assert.equal(ctx.calls.length, 0);
  ctx.control.set({ paused: false });
  assert.equal(await ctx.handle(fakeMsg()), "scheduled");
});

test("kill switch: pausing cancels every scheduled reply", async () => {
  const ctx = setup();
  const chats = [fakeChat({ id: "911@c.us" }), fakeChat({ id: "912@c.us" })];
  for (const chat of chats) await ctx.handle(fakeMsg({ chat }));
  assert.equal(ctx.queue.size, 2);
  ctx.control.set({ paused: true });
  await ctx.flush();
  assert.equal(ctx.queue.size, 0);
  assert.equal(ctx.activity.count(TODAY, "cancelled"), 2);
  ctx.control.set({ paused: false });
  await ctx.flush();
  assert.deepEqual(chats.map((c) => c.sent.length), [0, 0]);
});

test("kill switch: pausing during the typing pause stops that reply", async () => {
  const ctx = setup();
  const chat = fakeChat();
  chat.sendStateTyping = async () => {
    ctx.control.set({ paused: true });
  };
  await ctx.handle(fakeMsg({ chat }));
  await ctx.flush();
  assert.deepEqual(chat.sent, []);
});

test("model switcher: the chosen model is used for the next message", async () => {
  const ctx = setup();
  await ctx.handle(fakeMsg({ chat: fakeChat({ id: "911@c.us" }) }));
  runCommand(ctx.control, ["model", "haiku"]);
  await ctx.handle(fakeMsg({ chat: fakeChat({ id: "912@c.us" }) }));
  assert.deepEqual(ctx.models, ["claude-opus-5-5", "claude-haiku-5-5"]);
});

test("control commands", () => {
  const control = new ControlStore(null);
  assert.match(runCommand(control, ["status"]), /ON\. Model: claude-opus-5-5/);
  assert.match(runCommand(control, ["status"], () => "Scheduled: 3."), /Scheduled: 3\./);
  assert.match(runCommand(control, ["pause"]), /paused/i);
  assert.equal(control.get().paused, true);
  assert.match(runCommand(control, ["resume"]), /resumed/i);
  assert.equal(control.get().paused, false);
  assert.match(runCommand(control, ["model", "sonnet"]), /claude-sonnet-5-5/);
  assert.match(runCommand(control, ["model", "gpt"]), /Unknown model/);
  assert.equal(control.get().model, "claude-sonnet-5-5");
  assert.match(runCommand(control, ["nonsense"]), /Commands:/);
});

test("model names resolve to known models only", () => {
  assert.equal(resolveModel("Opus"), "claude-opus-5-5");
  assert.equal(resolveModel("claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(resolveModel("claude-3-opus"), null);
  assert.equal(new ControlStore(null, "nonsense").get().model, "claude-opus-5-5");
});

test("chat commands are recognised, and the agent's own messages are not", () => {
  assert.deepEqual(parseChatCommand("greeter pause"), ["pause"]);
  assert.deepEqual(parseChatCommand("  Greeter model Haiku "), ["model", "Haiku"]);
  assert.deepEqual(parseChatCommand("greeter"), ["help"]);
  assert.equal(parseChatCommand("greeters are nice"), null);
  assert.equal(parseChatCommand("Happy Diwali"), null);
  const control = new ControlStore(null);
  for (const args of [["pause"], ["resume"], ["status"], ["model", "haiku"], ["help"]]) {
    assert.equal(parseChatCommand(`🤖 ${runCommand(control, args)}`), null);
  }
  assert.equal(parseChatCommand(formatSummary(TODAY, [{ type: "replied", who: "A", occasion: "diwali" }], 0)), null);
});

test("control state persists across restarts, and a damaged file means paused", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "control-")), "control.json");
  new ControlStore(file).set({ paused: true, model: "claude-haiku-5-5" });
  assert.deepEqual(new ControlStore(file).get(), { paused: true, model: "claude-haiku-5-5" });
  fs.writeFileSync(file, "{not json");
  assert.equal(new ControlStore(file).get().paused, true);
});

// --- helpers ---

test("contact list matching by number and saved name", () => {
  const c = { number: "919876543210", id: { user: "919876543210" }, name: "Boss" };
  assert.equal(matchesContactList(c, ["+91 98765 43210"]), true);
  assert.equal(matchesContactList(c, ["98765-43210"]), true);
  assert.equal(matchesContactList(c, ["boss"]), true);
  assert.equal(matchesContactList(c, ["Bossman"]), false);
  assert.equal(matchesContactList(c, ["43210"]), false); // too short to be safe
  assert.equal(matchesContactList(c, ["+91 98765 00000"]), false);
  assert.equal(matchesContactList({ number: "", id: {}, name: "" }, ["Boss", "9876543210"]), false);
});

test("contact list files: comments and blank lines are skipped, missing file is empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "list-"));
  const file = path.join(dir, "list.txt");
  fs.writeFileSync(file, "# header\n\n+91 98765 43210  # office\nBoss\n");
  assert.deepEqual(loadContactList(file), ["+91 98765 43210", "Boss"]);
  assert.deepEqual(loadContactList(path.join(dir, "nope.txt")), []);
});

test("the shipped example lists contain only examples", () => {
  for (const name of ["ignore-contacts.example.txt", "close-contacts.example.txt"]) {
    const file = fileURLToPath(new URL(`../${name}`, import.meta.url));
    assert.equal(fs.existsSync(file), true, name);
    assert.deepEqual(loadContactList(file), [], name);
  }
});

test("time helpers", () => {
  assert.deepEqual(localParts(NOW, "Asia/Kolkata"), { date: TODAY, year: 2026, minuteOfDay: 15 * 60 + 30 });
  assert.equal(localParts(Date.parse("2026-12-31T19:00:00Z"), "Asia/Kolkata").year, 2027);
  const night = parseWindow("23:00-08:00");
  assert.equal(isInWindow(parseClock("23:30"), night), true);
  assert.equal(isInWindow(parseClock("07:59"), night), true);
  assert.equal(isInWindow(parseClock("08:00"), night), false);
  assert.equal(isInWindow(parseClock("14:00"), parseWindow("13:00-15:00")), true);
  assert.equal(parseWindow("off"), null);
  assert.throws(() => parseClock("25:00"));
  assert.throws(() => parseWindow("23:00"));
  assert.equal(endOfQuiet(NOW, night, "Asia/Kolkata"), NOW);
});

test("buildContent drops oversized or unsupported images", () => {
  assert.equal(buildContent({ text: "hi", image: { mimetype: "image/jpeg; codecs=x", data: "AAAA" } }).hasImage, true);
  assert.equal(buildContent({ text: "hi", image: { mimetype: "video/mp4", data: "AAAA" } }).hasImage, false);
  assert.equal(buildContent({ text: "hi", image: { mimetype: "image/png", data: "A".repeat(8_000_000) } }).hasImage, false);
});

test("occasion ids are normalised", () => {
  assert.equal(normaliseOccasion(" Bhai Dooj "), "bhai-dooj");
  assert.equal(normaliseOccasion("Eid al-Fitr"), "eid-al-fitr");
});
