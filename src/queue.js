// Replies waiting to be sent. Saved to disk, so a restart or redeploy doesn't
// lose them: they are sent when their time comes after the agent is back.
import { readJson, writeJson } from "./jsonfile.js";

/**
 * @typedef {object} PendingReply
 * @property {string} id
 * @property {string} chatId
 * @property {string} person       "<chat>|<sender>" key used for de-duplication
 * @property {string} who          display name for logs and summaries
 * @property {string} occasion
 * @property {number} year
 * @property {string} reply
 * @property {number} msgTimestamp epoch seconds of the greeting
 * @property {number} sendAt       epoch milliseconds
 */

export class PendingQueue {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {PendingReply[]} */
    this.jobs = readJson(filePath, []);
    if (!Array.isArray(this.jobs)) this.jobs = [];
  }

  get size() {
    return this.jobs.length;
  }

  hasPerson(person) {
    return this.jobs.some((job) => job.person === person);
  }

  /** @param {PendingReply} job */
  add(job) {
    this.jobs.push(job);
    this.save();
  }

  /** Jobs whose time has come, oldest first. */
  due(nowMs) {
    return this.jobs.filter((job) => job.sendAt <= nowMs).sort((a, b) => a.sendAt - b.sendAt);
  }

  remove(id) {
    this.jobs = this.jobs.filter((job) => job.id !== id);
    this.save();
  }

  /** Removes and returns every job (used by the kill switch). */
  clear() {
    const removed = this.jobs;
    this.jobs = [];
    this.save();
    return removed;
  }

  save() {
    writeJson(this.filePath, this.jobs);
  }
}
