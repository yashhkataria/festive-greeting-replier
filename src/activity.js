// What the agent did each day, by local date: drives the daily reply cap and
// the evening summary. Only the last few days are kept.
import { readJson, writeJson } from "./jsonfile.js";

const KEEP_DAYS = 7;

/**
 * Event types:
 *   replied    an automatic reply was sent
 *   reminded   a close person greeted you; you were asked to reply yourself
 *   you-replied you answered before the agent did
 *   capped     skipped because the daily limit was reached
 *   cancelled  dropped by the kill switch
 */
export class ActivityLog {
  constructor(filePath) {
    this.filePath = filePath;
    const data = readJson(filePath, {});
    this.days = data.days || {};
    this.summarySentFor = data.summarySentFor || null;
    this.limitNoticeFor = data.limitNoticeFor || null;
  }

  record(date, type, { who = "", occasion = "", text = "" } = {}) {
    (this.days[date] ??= []).push({ type, who, occasion, text, at: new Date().toISOString() });
    this.prune();
    this.save();
  }

  count(date, type) {
    return (this.days[date] || []).filter((event) => event.type === type).length;
  }

  events(date) {
    return this.days[date] || [];
  }

  markSummarySent(date) {
    this.summarySentFor = date;
    this.save();
  }

  /** Returns true the first time it is called for a date, so the limit notice is sent once a day. */
  claimLimitNotice(date) {
    if (this.limitNoticeFor === date) return false;
    this.limitNoticeFor = date;
    this.save();
    return true;
  }

  prune() {
    const dates = Object.keys(this.days).sort();
    for (const date of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete this.days[date];
  }

  save() {
    writeJson(this.filePath, { days: this.days, summarySentFor: this.summarySentFor, limitNoticeFor: this.limitNoticeFor });
  }
}

/** The evening summary text, or null when nothing happened that day. */
export function formatSummary(date, events, pendingCount) {
  const of = (type) => events.filter((event) => event.type === type);
  const list = (items) => items.map((e) => `• ${e.who} (${e.occasion})`).join("\n");
  const sections = [];
  const replied = of("replied");
  const reminded = of("reminded");
  const yours = of("you-replied");
  const capped = of("capped");
  const cancelled = of("cancelled");
  if (replied.length) sections.push(`Replied to ${replied.length}:\n${list(replied)}`);
  if (reminded.length) sections.push(`Waiting for your personal reply (${reminded.length}):\n${list(reminded)}`);
  if (yours.length) sections.push(`You replied yourself, so the agent stayed quiet: ${yours.length}`);
  if (capped.length) sections.push(`Skipped because the daily limit was reached: ${capped.length}`);
  if (cancelled.length) sections.push(`Cancelled by the kill switch: ${cancelled.length}`);
  if (!sections.length && !pendingCount) return null;
  if (pendingCount) sections.push(`Still scheduled to send: ${pendingCount}`);
  return `🤖 Greetings summary for ${date}\n\n${sections.join("\n\n")}`;
}
