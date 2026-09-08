// In-memory FIFO for paid render jobs. Strictly one job runs at a time
// across every board; the review UI polls snapshot(). Nothing here retries:
// a failed job stays failed with its error, and the queue moves on. State
// lives only for the server's lifetime — render RECORDS are persisted by the
// job itself (results.json), so a restart loses nothing but the list.

import { randomUUID } from "node:crypto";

export class RenderQueue {
  #execute;
  #jobs = [];
  #controllers = new Map();
  #running = false;
  #idleResolvers = [];

  constructor({ execute }) {
    this.#execute = execute;
  }

  get idle() {
    if (!this.#running && !this.#jobs.some((job) => job.state === "queued")) return Promise.resolve();
    return new Promise((resolve) => this.#idleResolvers.push(resolve));
  }

  enqueue(fields) {
    const job = {
      jobId: `q-${randomUUID().slice(0, 8)}`,
      boardId: fields.boardId,
      kind: fields.kind,
      variant: fields.variant ?? null,
      count: fields.count ?? null,
      instructionSnapshot: fields.instructionSnapshot ?? "",
      selectionHash: fields.selectionHash ?? null,
      state: "queued",
      progress: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.#jobs.push(job);
    const position = this.#jobs.filter((entry) => entry.state === "queued" || entry.state === "running").length;
    queueMicrotask(() => this.#kick());
    return { jobId: job.jobId, position };
  }

  cancel(jobId) {
    const job = this.#jobs.find((entry) => entry.jobId === jobId);
    if (!job) return false;
    if (job.state === "queued") {
      job.state = "cancelled";
      job.finishedAt = new Date().toISOString();
      return true;
    }
    if (job.state === "running") {
      this.#controllers.get(jobId)?.abort(Object.assign(new Error("Cancelled by user."), { name: "AbortError" }));
      return true;
    }
    return false;
  }

  snapshot() {
    return this.#jobs.map((job) => ({ ...job }));
  }

  async #kick() {
    if (this.#running) return;
    const job = this.#jobs.find((entry) => entry.state === "queued");
    if (!job) {
      for (const resolve of this.#idleResolvers.splice(0)) resolve();
      return;
    }
    this.#running = true;
    const controller = new AbortController();
    this.#controllers.set(job.jobId, controller);
    job.state = "running";
    job.startedAt = new Date().toISOString();
    try {
      await this.#execute(job, { signal: controller.signal, onProgress: (text) => { job.progress = text; } });
      job.state = "done";
    } catch (error) {
      if (controller.signal.aborted) {
        job.state = "cancelled";
      } else {
        job.state = "failed";
        job.error = { message: error?.message ?? String(error), status: error?.status, code: error?.code, retryAfterMs: error?.retryAfterMs };
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      this.#controllers.delete(job.jobId);
      this.#running = false;
      queueMicrotask(() => this.#kick());
    }
  }
}
