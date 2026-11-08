// Sends scheduled replies when their time comes, applies the kill switch and
// daily limit at the last moment, and posts the evening summary.
import { formatSummary } from "./activity.js";
import { localParts } from "./time.js";

/**
 * @param {object} deps
 * @param {import("./queue.js").PendingQueue} deps.queue
 * @param {import("./agent.js").RepliedStore} deps.store
 * @param {import("./activity.js").ActivityLog} deps.activity
 * @param {{ get: () => { paused: boolean } }} deps.control
 * @param {(chatId: string) => Promise<object>} deps.getChat
 * @param {(text: string) => Promise<void>} deps.notifySelf
 * @param {object} deps.config  { timeZone, dailyLimit, maxMessageAgeSeconds, summaryTime (minutes or null) }
 */
export function createScheduler({ queue, store, activity, control, getChat, notifySelf, config, now = Date.now, sleep = defaultSleep, log = console }) {
  let running = false;

  async function tick() {
    if (running) return; // a slow tick (typing pause) must not overlap the next one
    running = true;
    try {
      if (control.get().paused) {
        // Kill switch: everything waiting is dropped, not delayed.
        const today = localParts(now(), config.timeZone).date;
        for (const job of queue.clear()) {
          activity.record(today, "cancelled", { who: job.who, occasion: job.occasion });
          log.log(`[scheduler] kill switch: cancelled reply to ${job.who}`);
        }
      } else {
        for (const job of queue.due(now())) {
          if (control.get().paused) break;
          await sendJob(job);
        }
      }
      await maybeSendSummary();
    } finally {
      running = false;
    }
  }

  async function sendJob(job) {
    // Removed before sending: a crash mid-send can lose one reply but never send it twice.
    queue.remove(job.id);
    const today = localParts(now(), config.timeZone).date;
    try {
      if (now() / 1000 - job.msgTimestamp > config.maxMessageAgeSeconds) {
        log.log(`[scheduler] dropped stale reply to ${job.who}`);
        return "dropped:too-old";
      }
      if (store.hasOccasion(job.person, job.occasion, job.year)) return "dropped:already-replied";
      if (config.dailyLimit > 0 && activity.count(today, "replied") >= config.dailyLimit) {
        activity.record(today, "capped", { who: job.who, occasion: job.occasion });
        if (activity.claimLimitNotice(today)) {
          await notifySelf(`🤖 Daily limit of ${config.dailyLimit} automatic replies reached. Other greetings today are left for you.`);
        }
        return "dropped:daily-limit";
      }

      const chat = await getChat(job.chatId);
      if (await youAlreadyReplied(chat, job.msgTimestamp)) {
        store.add(job.person, job.occasion, job.year, new Date(now()));
        activity.record(today, "you-replied", { who: job.who, occasion: job.occasion });
        log.log(`[scheduler] you already replied to ${job.who}; staying quiet`);
        return "dropped:you-replied";
      }

      try {
        await chat.sendStateTyping();
      } catch {}
      await sleep(Math.min(2000 + job.reply.length * 40, 6000));
      // Kill switch, checked again at the very last moment.
      if (control.get().paused) {
        try {
          await chat.clearState();
        } catch {}
        activity.record(today, "cancelled", { who: job.who, occasion: job.occasion });
        return "dropped:paused";
      }

      // sendSeen: false keeps the chat unread on your phone, so you still see the greeting yourself.
      await chat.sendMessage(job.reply, { sendSeen: false });
      try {
        await chat.clearState();
      } catch {}
      store.add(job.person, job.occasion, job.year, new Date(now()));
      activity.record(today, "replied", { who: job.who, occasion: job.occasion, text: job.reply });
      log.log(`[scheduler] replied to ${job.who} (${job.occasion}): ${job.reply}`);
      return "sent";
    } catch (err) {
      log.error(`[scheduler] could not send reply to ${job.who}: ${err.stack || err.message}`);
      return "error";
    }
  }

  async function maybeSendSummary() {
    if (config.summaryTime == null) return;
    const { date, minuteOfDay } = localParts(now(), config.timeZone);
    if (minuteOfDay < config.summaryTime || activity.summarySentFor === date) return;
    activity.markSummarySent(date);
    const text = formatSummary(date, activity.events(date), queue.size);
    if (!text) return;
    try {
      await notifySelf(text);
    } catch (err) {
      log.error(`[scheduler] could not send the daily summary: ${err.message}`);
    }
  }

  async function youAlreadyReplied(chat, sinceTimestamp) {
    try {
      const recent = await chat.fetchMessages({ limit: 20 });
      return recent.some((m) => m.fromMe && m.timestamp >= sinceTimestamp);
    } catch (err) {
      log.warn(`[scheduler] could not check recent messages: ${err.message}`);
      return false;
    }
  }

  return { tick, sendJob };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
