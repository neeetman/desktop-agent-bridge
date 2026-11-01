import {performance} from 'node:perf_hooks';

export const HEALTH_POLICY = Object.freeze({
  intervalMs: 30000,
  serviceTimeoutMs: 10000,
  nativeTimeoutMs: 75000,
  failuresBeforeAlert: 3,
  minimumFailureMs: 60000,
  responseWaitMs: 2500,
});

// Only read-only health requests use these budgets. Native writes are never retried.
export class HealthMonitor {
  constructor({request, initial = {}, onResult = () => {}, now = Date.now, policy = {}}) {
    this.request = request;
    this.rows = initial;
    this.onResult = onResult;
    this.now = now;
    this.policy = {...HEALTH_POLICY, ...policy};
    this.inFlight = new Map();
    this.lastStarted = new Map();
    this.controllers = new Set();
    this.closed = false;
  }

  probe(app) {
    if (this.closed) return Promise.resolve(this.rows[app]);
    if (this.inFlight.has(app)) return this.inFlight.get(app);
    const started = this.lastStarted.get(app);
    if (started !== undefined && this.now() - started < this.policy.intervalMs) return Promise.resolve(this.rows[app]);
    this.lastStarted.set(app, this.now());
    const pending = this.run(app).finally(() => this.inFlight.delete(app));
    this.inFlight.set(app, pending);
    return pending;
  }

  async step(app, step, route, timeoutMs, steps) {
    const started = performance.now(), controller = new AbortController();
    this.controllers.add(controller);
    let timer, onAbort;
    const timeout = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new Error('Health probe cancelled'));
      controller.signal.addEventListener('abort', onAbort, {once: true});
      timer = setTimeout(() => {
        const error = Object.assign(new Error(`Health ${step} exceeded ${timeoutMs} ms`), {code: 'HEALTH_PROBE_TIMEOUT'});
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => this.request(app, route, 'GET', undefined, undefined, {signal: controller.signal, timeoutMs, healthProbe: true})),
        timeout,
      ]);
      if (value?.ok === false) throw Object.assign(new Error('Service reports unhealthy'), {code: 'SERVICE_UNHEALTHY'});
      steps.push({step, route, timeoutMs, elapsedMs: Math.round(performance.now() - started), ok: true});
      return value;
    } catch (error) {
      const timedOut = /timeout|timed out|aborted due to timeout/i.test(error.message ?? '') || ['TimeoutError', 'AbortError'].includes(error.name);
      steps.push({step, route, timeoutMs, elapsedMs: Math.round(performance.now() - started), ok: false,
        errorCode: typeof error.code === 'string' ? error.code : timedOut ? 'HEALTH_PROBE_TIMEOUT' : 'HEALTH_PROBE_FAILED', httpStatus: error.status ?? null, error: error.message});
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      this.controllers.delete(controller);
    }
  }

  async run(app) {
    const previous = this.rows[app] ?? {}, startedAt = new Date(this.now()).toISOString(), started = performance.now(), steps = [];
    const oldConfirmed = Object.hasOwn(previous, 'confirmedOk') ? previous.confirmedOk : previous.ok;
    let service, error;
    try {
      service = await this.step(app, 'service_http', '/health', this.policy.serviceTimeoutMs, steps);
      await this.step(app, 'native_threads', '/v1/threads?limit=1', this.policy.nativeTimeoutMs, steps);
    } catch (caught) { error = caught; }
    if (this.closed) return this.rows[app];
    const now = this.now(), checkedAt = new Date(now).toISOString(), ok = !error;
    const consecutiveFailures = ok ? 0 : (previous.consecutiveFailures ?? 0) + 1;
    const firstFailureAt = ok ? null : previous.firstFailureAt ?? checkedAt;
    let confirmedOk = oldConfirmed;
    if (ok) confirmedOk = true;
    else if (consecutiveFailures >= this.policy.failuresBeforeAlert && now - Date.parse(firstFailureAt) >= this.policy.minimumFailureMs) confirmedOk = false;
    const failed = steps.find(step => !step.ok);
    const row = {
      app, ok, confirmedOk: confirmedOk ?? null,
      status: ok ? 'healthy' : confirmedOk === false ? 'unhealthy' : 'degraded',
      startedAt, checkedAt, elapsedMs: Math.round(performance.now() - started),
      lastSuccessAt: ok ? checkedAt : previous.lastSuccessAt ?? null,
      transport: service?.transport ?? previous.transport ?? null,
      consecutiveFailures, firstFailureAt, steps,
      failedStep: failed?.step ?? null, errorCode: failed?.errorCode ?? null, error: error?.message ?? null,
      lastFailure: failed ? {...failed, checkedAt, consecutiveFailures} : previous.lastFailure ?? null,
      recoveredFailures: ok ? previous.consecutiveFailures ?? 0 : 0,
      repair: ok ? null : confirmedOk === false
        ? 'Persistent probe failure. Inspect bridge_health steps and service logs; check compatibility after upgrades. Repair only when the affected work is idle.'
        : 'Transient or unconfirmed failure; wait for the next independent read-only probe. Do not restart desktops or replay tasks.',
    };
    this.rows[app] = row;
    const transition = confirmedOk === false && oldConfirmed !== false ? 'failure'
      : confirmedOk === true && oldConfirmed === false ? 'recovery' : null;
    this.onResult(row, transition);
    return row;
  }

  snapshot(app) {
    const row = this.rows[app];
    return {...(row ?? {app, ok: null, confirmedOk: null, status: 'checking', lastSuccessAt: null}),
      checking: this.inFlight.has(app), ageMs: row?.checkedAt ? Math.max(0, this.now() - Date.parse(row.checkedAt)) : null};
  }

  async check(apps) {
    const pending = apps.map(app => this.probe(app));
    let timer;
    try {
      await Promise.race([Promise.all(pending), new Promise(resolve => {timer = setTimeout(resolve, this.policy.responseWaitMs);})]);
    } finally { clearTimeout(timer); }
    const results = apps.map(app => this.snapshot(app));
    return {ok: results.every(row => row.ok === true), checking: results.some(row => row.checking), policy: this.policy, results};
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort(new Error('Health monitor closed'));
  }
}
