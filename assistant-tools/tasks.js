'use strict';
const { fs, path, crypto, text, fail, publicData, hash } = require('./common');
const { parseSchedule, advance } = require('./schedule');
const OMIT = /^(\.git|node_modules|target|server-data|\.env(?:\..*)?|\.ssh|\.aws|\.codex|native|image|video-pub)$/i;
class TaskTools {
  constructor(store, run, emit) { this.store = store; this.run = run; this.emit = emit; this.active = new Map(); this.users = new Set(); this.timer = null; }
  recover(userId) {
    if (this.users.has(userId)) return;
    this.users.add(userId); const rows = this.store.read(userId, 'tasks'); let changed = false;
    for (const row of rows) if (['running', 'queued'].includes(row.status)) { row.status = 'interrupted'; row.error = 'Server restarted; inspect partial results before explicitly resuming.'; changed = true; }
    if (changed) this.store.write(userId, 'tasks', rows);
  }
  startScheduler(users) {
    for (const user of users) this.recover(user.id);
    this.timer = setInterval(() => this.tick().catch(error => this.emit(null, { type: 'scheduler_error', error: error.message })), 10000); this.timer.unref();
  }
  async delegate(input, ctx) {
    this.recover(ctx.userId);
    const action = input.action || 'start';
    if (['list', 'status', 'result', 'cancel', 'resume'].includes(action)) return this.manage(action, input, ctx);
    if (action !== 'start') throw fail('Unknown delegation action.');
    if (Array.isArray(input.tasks)) {
      if (!input.tasks.length || input.tasks.length > 8) throw fail('One to eight delegation tasks are allowed.');
      const results = []; for (const task of input.tasks) results.push(await this.delegate({ ...task, background: input.background === true }, ctx)); return { tasks: results };
    }
    if ([...this.active.values()].filter(v => v.userId === ctx.userId).length >= 4) throw fail('Four background agents are already running.', 'concurrency_limit', 429);
    const goal = text(input.goal || input.objective, 'goal', 32000), id = crypto.randomUUID();
    const root = isolatedWorkspace(this.store, ctx, id);
    const row = publicData({ id, title: goal.slice(0, 160), prompt: goal, context: String(input.context || '').slice(0, 32000), root, parentRoot: ctx.root, model: ctx.model, submodel: ctx.submodel, permissionMode: ctx.permissionMode, status: 'queued', createdAt: new Date().toISOString(), events: [], source: input.source || 'delegation' });
    const rows = this.store.read(ctx.userId, 'tasks'); rows.push(row); this.store.write(ctx.userId, 'tasks', rows.slice(-500));
    const promise = this.execute(row, input.background===true ? {...ctx,signal:undefined} : ctx);
    if (input.background === true) { promise.catch(() => {}); return { delegation_id: id, status: 'queued', workspace: root }; }
    return promise;
  }
  async execute(row, ctx) {
    const controller = new AbortController(); this.active.set(row.id, { controller, userId: ctx.userId });
    const parentAbort=()=>controller.abort();ctx.signal?.addEventListener('abort',parentAbort,{once:true});if(ctx.signal?.aborted)controller.abort();
    this.update(ctx.userId, row.id, { status: 'running', startedAt: new Date().toISOString() });
    try {
      const result = await this.run(ctx.userId, { root: row.root, model: row.model, submodel: row.submodel, permissionMode: row.permissionMode, message: row.prompt + (row.context ? '\nCONTEXT:\n' + row.context : ''), assistantTaskId: row.id }, controller.signal, event => {
        const state = this.update(ctx.userId, row.id, previous => ({ events: [...(previous.events || []), publicData(event)].slice(-150) }));
        this.emit(ctx.userId, { type: 'background_event', taskId: row.id, event });
        if (['permission_required', 'plan_required', 'budget_required', 'question_required'].includes(event.type)) ctx.emit?.(event);
      });
      if (controller.signal.aborted) throw fail('Task cancelled.', 'cancelled', 499);
      if (result.error) throw fail(result.error, 'agent_error', 502);
      const done = this.update(ctx.userId, row.id, { status: 'completed', result: publicData(result), finishedAt: new Date().toISOString() });
      this.emit(ctx.userId, { type: 'background_completed', taskId: row.id, status: done.status }); return { delegation_id: row.id, workspace: row.root, status: done.status, result: done.result };
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      this.update(ctx.userId, row.id, { status, error: error.message, finishedAt: new Date().toISOString() }); this.emit(ctx.userId, { type: 'background_completed', taskId: row.id, status, error: error.message });
      return { delegation_id: row.id, workspace: row.root, status, error: error.message };
    } finally { ctx.signal?.removeEventListener('abort',parentAbort);this.active.delete(row.id); }
  }
  update(user, id, patch) { const rows = this.store.read(user, 'tasks'), row = rows.find(r => r.id === id); if (!row) throw fail('Task not found.'); Object.assign(row, typeof patch === 'function' ? patch(row) : patch); this.store.write(user, 'tasks', rows); return row; }
  manage(action, input, ctx) {
    const rows = this.store.read(ctx.userId, 'tasks').filter(row => row.parentRoot === ctx.root || input.scope === 'account');
    if (action === 'list') return { tasks: rows.map(({ events, result, context, prompt, ...row }) => row) };
    const row = rows.find(r => r.id === (input.delegation_id || input.id)); if (!row) throw fail('Delegation not found.', 'not_found', 404);
    if (action === 'cancel') { const active = this.active.get(row.id); if (active) active.controller.abort(); else this.update(ctx.userId, row.id, { status: 'cancelled' }); return { id: row.id, cancelling: !!active }; }
    if (action === 'resume') { if (this.active.has(row.id)) throw fail('Task is running.');if([...this.active.values()].filter(v=>v.userId===ctx.userId).length>=4)throw fail('Four background agents are already running.','concurrency_limit',429); this.execute(row, ctx).catch(() => {}); return { id: row.id, status: 'running' }; }
    return publicData(row);
  }
  cron(input, ctx) {
    if(input.skills!==undefined&&(!Array.isArray(input.skills)||input.skills.length>20||input.skills.some(s=>typeof s!=='string'||!s.trim()||s.length>80)))throw fail('Skills must be at most twenty explicit skill names.');
    this.recover(ctx.userId); const action = input.action || 'list', rows = this.store.read(ctx.userId, 'cron');
    if (action === 'list' || action === 'status') return { running: !!this.timer, requiresServerRunning: true, jobs: rows.filter(r => r.parentRoot === ctx.root || input.scope === 'account') };
    if (action === 'history' || action === 'runs') return { runs: this.store.read(ctx.userId, 'tasks').filter(r => r.source === 'cron' && (!input.job_id || r.jobId === input.job_id)) };
    let row = rows.find(r => r.id === input.job_id && r.parentRoot === ctx.root);
    if (action === 'create') {
      row = { id: crypto.randomUUID(), name: String(input.name || input.prompt || '').slice(0, 160), prompt: text(input.prompt, 'prompt', 32000), root: ctx.root, parentRoot: ctx.root, model: ctx.model, submodel: ctx.submodel, permissionMode: ctx.permissionMode, schedule: parseSchedule(input.schedule, Date.now(), input.timezone || 'Europe/Paris'), paused: !!input.paused, skills: input.skills || [], createdAt: new Date().toISOString() };
      if (rows.length >= 100) throw fail('Scheduled job limit reached.'); rows.push(row);
    } else {
      if (!row) throw fail('Job not found in this project.', 'not_found', 404);
      if (action === 'update') { if (input.prompt !== undefined) row.prompt = text(input.prompt, 'prompt', 32000); if (input.schedule !== undefined) row.schedule = parseSchedule(input.schedule, Date.now(), input.timezone || row.schedule.timeZone); if (input.name !== undefined) row.name = String(input.name).slice(0, 160); if (input.skills !== undefined) row.skills = input.skills; }
      else if (action === 'pause' || action === 'resume') row.paused = action === 'pause';
      else if (action === 'run') row.schedule.nextAt = Date.now();
      else if (action === 'remove') { this.store.write(ctx.userId, 'cron', rows.filter(r => r !== row)); return { removed: row.id }; }
      else throw fail('Unknown scheduled-job action.');
    }
    this.store.write(ctx.userId, 'cron', publicData(rows)); return row;
  }
  async tick(now = Date.now()) {
    for (const userId of this.users) {
      const rows = this.store.read(userId, 'cron');
      for (const row of rows) {
        if (row.paused || !row.schedule.nextAt || row.schedule.nextAt > now || [...this.active.values()].some(v => v.userId === userId)) continue;
        row.schedule.nextAt = advance(row.schedule, now); row.lastDispatchedAt = new Date(now).toISOString(); if (!row.schedule.nextAt) row.paused = true;
        this.store.write(userId, 'cron', rows);
        const id = crypto.randomUUID(), task = { ...row, id, jobId: row.id, title: row.name, context: row.skills.length ? 'Load these configured skills: ' + row.skills.join(', ') : '', source: 'cron', status: 'queued', events: [] };
        const tasks = this.store.read(userId, 'tasks'); tasks.push(task); this.store.write(userId, 'tasks', tasks.slice(-500));
        this.execute(task, { userId, root: row.root, permissionMode: row.permissionMode }).catch(() => {});
      }
    }
  }
  stop() { clearInterval(this.timer); this.timer = null; for (const active of this.active.values()) active.controller.abort(); }
}
function isolatedWorkspace(store, ctx, id) {
  const destination = path.join(store.root, hash(ctx.userId), 'workspaces', id); fs.mkdirSync(destination, { recursive: true });
  let total = 0, count = 0;
  function walk(source, target) {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (OMIT.test(entry.name) || entry.isSymbolicLink() || /\.(pem|key|p12|pfx)$/i.test(entry.name)) continue;
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (entry.isDirectory()) { if (source.split(path.sep).length - ctx.root.split(path.sep).length > 30) throw fail('Workspace depth limit.'); fs.mkdirSync(to); walk(from, to); }
      else if (entry.isFile()) { total += fs.statSync(from).size; if (++count > 10000 || total > 100 * 1024 * 1024) throw fail('Workspace snapshot exceeds 100 MiB / 10,000 files.'); fs.copyFileSync(from, to); }
    }
  }
  walk(fs.realpathSync(ctx.root), destination); return destination;
}
module.exports = { TaskTools, isolatedWorkspace };
