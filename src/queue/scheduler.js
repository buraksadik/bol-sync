/**
 * Scheduler. Enqueues the recurring work; it never calls bol itself.
 *
 * Everything goes through the same queue as webhook-driven work, so there is a
 * single place where the rate limit is respected.
 */

import { PRIORITY } from '../sync/differ.js';

/** @typedef {import('./worker.js').WorkerContext} WorkerContext */

/**
 * @typedef {object} Schedule
 * @property {string} name
 * @property {number} intervalMs
 * @property {(ctx: WorkerContext) => Promise<void>} tick
 */

const MINUTE = 60000;

/**
 * Tenants the scheduler should enqueue for. `ctx.listActiveTenants` is wired in
 * src/index.js; the fallback keeps the scheduler testable on its own.
 *
 * @param {WorkerContext & { listActiveTenants?: () => Promise<Array<{ id: string }>> }} ctx
 * @returns {Promise<Array<{ id: string }>>}
 */
async function tenantsOf(ctx) {
  return ctx.listActiveTenants ? ctx.listActiveTenants() : [];
}

/**
 * Has the wall clock passed `hh:mm` today, and did we not already run?
 *
 * Deliberately local time, not UTC. The full reconcile belongs in the Dutch
 * night when the shop is quiet; on a UTC+3 machine 03:30 local is 01:30 in
 * Amsterdam, which is the window we want.
 *
 * @param {string} hhmm
 * @param {string|null} lastRunDay   YYYY-MM-DD of the last run
 * @param {Date} [now]
 * @returns {{ due: boolean, day: string }}
 */
export function dailyDue(hhmm, lastRunDay, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const due = lastRunDay !== day && minutesNow >= h * 60 + m;
  return { due, day };
}

/**
 * - pull_source       every PULL_SOURCE_INTERVAL_MIN, per tenant
 * - reconcile         every RECONCILE_INTERVAL_MIN, incremental
 * - reconcile full    once a day at RECONCILE_FULL_AT
 * - release stuck     every minute
 * - dead letter digest once a day
 *
 * @param {import('../config.js').Config} config
 * @returns {Schedule[]}
 */
export function buildSchedules(config) {
  /** Closure state for the once-a-day schedules. */
  let lastFullReconcileDay = /** @type {string|null} */ (null);
  let lastDigestDay = /** @type {string|null} */ (null);

  return [
    {
      name: 'pull_source',
      intervalMs: config.schedule.pullSourceIntervalMin * MINUTE,
      async tick(ctx) {
        const tenants = await tenantsOf(ctx);
        if (tenants.length === 0) return;
        await ctx.repos.jobs.enqueueMany(
          tenants.map((t) => ({
            tenantId: t.id,
            productId: null,
            type: 'pull_source',
            // One open pull per tenant, however often the timer fires.
            dedupeKey: `${t.id}:pull_source`,
            payload: { trigger: 'schedule' },
            priority: PRIORITY.PULL_SOURCE,
            maxAttempts: 3,
            runAfter: new Date(),
          })),
        );
      },
    },

    {
      name: 'reconcile_incremental',
      intervalMs: config.schedule.reconcileIntervalMin * MINUTE,
      async tick(ctx) {
        const tenants = await tenantsOf(ctx);
        if (tenants.length === 0) return;
        await ctx.repos.jobs.enqueueMany(
          tenants.map((t) => ({
            tenantId: t.id,
            productId: null,
            type: 'reconcile',
            dedupeKey: `${t.id}:reconcile:incremental`,
            payload: { mode: 'incremental' },
            priority: PRIORITY.RECONCILE,
            maxAttempts: 3,
            runAfter: new Date(),
          })),
        );
      },
    },

    {
      name: 'reconcile_full',
      intervalMs: MINUTE,
      async tick(ctx) {
        const { due, day } = dailyDue(config.schedule.reconcileFullAt, lastFullReconcileDay);
        if (!due) return;
        lastFullReconcileDay = day;

        const tenants = await tenantsOf(ctx);
        if (tenants.length === 0) return;
        await ctx.repos.jobs.enqueueMany(
          tenants.map((t) => ({
            tenantId: t.id,
            productId: null,
            type: 'reconcile',
            dedupeKey: `${t.id}:reconcile:full`,
            payload: { mode: 'full' },
            priority: PRIORITY.RECONCILE,
            maxAttempts: 2,
            runAfter: new Date(),
          })),
        );
        ctx.log?.info({ tenants: tenants.length }, 'full reconcile enqueued');
      },
    },

    {
      name: 'release_stuck',
      intervalMs: MINUTE,
      async tick(ctx) {
        const released = await ctx.repos.jobs.releaseStuck(ctx.config.worker.stuckAfterMs);
        if (released > 0) ctx.log?.warn({ released }, 'released stuck jobs');
      },
    },

    {
      name: 'dead_letter_digest',
      intervalMs: MINUTE,
      async tick(ctx) {
        const { due, day } = dailyDue('08:00', lastDigestDay);
        if (!due) return;
        lastDigestDay = day;

        for (const t of await tenantsOf(ctx)) {
          const open = await ctx.repos.jobs.openDeadLetters(t.id, 50);
          if (open.length > 0) {
            ctx.log?.warn(
              { tenantId: t.id, count: open.length, reasons: summarise(open) },
              'open dead letters',
            );
          }
        }
      },
    },
  ];
}

/**
 * @param {Array<{ reason: string }>} rows
 * @returns {Record<string, number>}
 */
function summarise(rows) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const r of rows) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
  return counts;
}

export class Scheduler {
  /**
   * @param {object} o
   * @param {WorkerContext} o.ctx
   * @param {Schedule[]} o.schedules
   */
  constructor({ ctx, schedules }) {
    this.ctx = ctx;
    this.schedules = schedules;
    /** @type {NodeJS.Timeout[]} */
    this.timers = [];
    /** @type {Set<string>} names currently mid-tick */
    this.busy = new Set();
  }

  /** @returns {void} */
  start() {
    if (this.timers.length > 0) return;

    for (const schedule of this.schedules) {
      const fire = async () => {
        // A tick that takes longer than its interval must not stack up.
        if (this.busy.has(schedule.name)) return;
        this.busy.add(schedule.name);
        try {
          await schedule.tick(this.ctx);
        } catch (err) {
          // A failing schedule never takes the process down; the next tick retries.
          this.ctx.log?.error({ err, schedule: schedule.name }, 'schedule tick failed');
        } finally {
          this.busy.delete(schedule.name);
        }
      };

      const timer = setInterval(fire, schedule.intervalMs);
      // Keeping the event loop alive is the worker's job, not the timers'.
      timer.unref?.();
      this.timers.push(timer);
    }
  }

  /**
   * Run one schedule now, by name. Used by tests and by the health endpoint's
   * "reconcile now" action.
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  async runNow(name) {
    const schedule = this.schedules.find((s) => s.name === name);
    if (!schedule) throw new Error(`unknown schedule: ${name}`);
    await schedule.tick(this.ctx);
  }

  /** @returns {void} */
  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}
