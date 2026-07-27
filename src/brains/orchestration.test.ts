/**
 * Self-check for the multi-brain orchestration framework.
 * No framework. Run with:  npm run compile && node out/brains/orchestration.test.js
 *
 * Same shape as engine.test.ts: 'vscode' only exists inside the extension host,
 * so a stub goes into the module loader before anything that imports it is
 * required — which is why the modules below come in through require(), not
 * import (TypeScript hoists imports above every statement).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const trashed: string[] = [];

const Module = require('module');
const realLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') {
    return {
      Uri: { file: (p: string) => ({ fsPath: p }) },
      workspace: {
        fs: {
          async delete(uri: any) {
            trashed.push(uri.fsPath);
            fs.rmSync(uri.fsPath, { recursive: true, force: true });
          },
        },
      },
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { matchGlob, toRelative } = require('./glob');
const { StagingWorkspace, BrainStage, createBrainDispatch, toolAllowed } = require('./staging');
const { ConflictResolver, mergeDisjoint } = require('./conflicts');
const { ConsensusEngine, parseReviews, parseDecision } = require('./consensus');
const { parseReport, extractJson } = require('./runner');
const { MemoryManager, InMemoryPersistence } = require('./memory');
const { ConversationBus } = require('./bus');
const { BrainRegistry } = require('./registry');
const { TaskPlanner, breakCycles, topoOrder } = require('./planner');
const { Scheduler } = require('./scheduler');
const { Executor, changeSetStat } = require('./executor');
const { estimateCost, priceOf } = require('./router');
const { DEFAULT_BRAINS } = require('./defaults');
const { ORCHESTRATION_DEFAULTS } = require('./types');

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinity-brains-'));
  temps.push(dir);
  return dir;
}

let passed = 0;
function ok(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${label}`);
    })
    .catch(e => {
      console.error(`FAIL  ${label}\n      ${e?.message || e}`);
      process.exitCode = 1;
    });
}

// ── fixtures ───────────────────────────────────────────────────────────────

function brain(patch: any = {}) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_BRAINS.find((b: any) => b.id === 'backend'))),
    ...patch,
  };
}

function proposal(patch: any = {}) {
  return {
    key: 't1#backend',
    taskId: 't1',
    brainId: 'backend',
    provider: 'nvidia',
    model: 'test-model',
    summary: 's',
    reasoning: '',
    pros: [],
    cons: [],
    risks: [],
    evidence: [],
    complexity: 'medium',
    confidence: 0.6,
    changes: [],
    raw: '',
    latencyMs: 1000,
    tokensIn: 100,
    tokensOut: 100,
    costUsd: 0.01,
    ...patch,
  };
}

async function main() {
  console.log('brains — glob');

  await ok('** matches across and through zero directories', () => {
    assert.ok(matchGlob('src/a/b/c.ts', 'src/**/*.ts'));
    assert.ok(matchGlob('src/c.ts', 'src/**/*.ts'), '** must also match zero directories');
    assert.ok(!matchGlob('lib/c.ts', 'src/**/*.ts'));
  });

  await ok('single * does not cross a directory boundary', () => {
    assert.ok(matchGlob('src/a.ts', 'src/*.ts'));
    assert.ok(!matchGlob('src/a/b.ts', 'src/*.ts'));
  });

  await ok('brace alternation', () => {
    assert.ok(matchGlob('app/page.tsx', '**/*.{ts,tsx}'));
    assert.ok(!matchGlob('app/page.css', '**/*.{ts,tsx}'));
  });

  await ok('toRelative normalises separators and strips the root', () => {
    assert.strictEqual(toRelative('C:\\proj', 'C:\\proj\\src\\a.ts'), 'src/a.ts');
  });

  console.log('brains — tool policy and staging');

  await ok('deny beats allow', () => {
    const b = brain({ tools: { allow: ['*'], deny: ['run_command'] } });
    assert.ok(toolAllowed(b, 'read_file'));
    assert.ok(!toolAllowed(b, 'run_command'));
  });

  await ok('a tool outside the allow list is refused in prose, not thrown', async () => {
    const root = tempDir();
    const staging = new StagingWorkspace(root);
    const dispatch = createBrainDispatch({
      brain: brain({ tools: { allow: ['read_file'], deny: [] } }),
      stage: new BrainStage(staging, 'backend', 't1'),
      workspaceRoot: root,
      base: async () => 'SHOULD NOT REACH THE REAL DISPATCHER',
    });
    const out = await dispatch('write_file', { path: 'server/x.ts', content: 'x' }, {});
    assert.ok(/not available to you/.test(out), out);
  });

  await ok('a write outside the brain’s scope is refused and stages nothing', async () => {
    const root = tempDir();
    const staging = new StagingWorkspace(root);
    const stage = new BrainStage(staging, 'backend', 't1');
    const dispatch = createBrainDispatch({
      brain: brain({ contextRules: { ...brain().contextRules, include: ['server/**'] } }),
      stage,
      workspaceRoot: root,
      base: async () => 'unused',
    });
    const out = await dispatch('write_file', { path: 'src/components/Button.tsx', content: 'x' }, {});
    assert.ok(/may not change/.test(out), out);
    assert.strictEqual(stage.changes().length, 0);
  });

  await ok('a staged write never touches disk and is readable back', async () => {
    const root = tempDir();
    const staging = new StagingWorkspace(root);
    const stage = new BrainStage(staging, 'backend', 't1');
    const dispatch = createBrainDispatch({
      brain: brain({ contextRules: { ...brain().contextRules, include: ['**/*'] } }),
      stage,
      workspaceRoot: root,
      base: async () => 'unused',
    });

    await dispatch('write_file', { path: 'api/auth.ts', content: 'line1\nline2' }, {});
    assert.ok(!fs.existsSync(path.join(root, 'api/auth.ts')), 'staging must not write to disk');

    const read = await dispatch('read_file', { path: 'api/auth.ts' }, {});
    assert.ok(read.includes('line1'), read);

    const edited = await dispatch('edit_file', { path: 'api/auth.ts', old_text: 'line2', new_text: 'line2b' }, {});
    assert.ok(/Staged 1 replacement/.test(edited), edited);
    assert.strictEqual(stage.changes().length, 1, 'two writes to one file collapse to one change');
    assert.strictEqual(stage.changes()[0].after, 'line1\nline2b');
    assert.strictEqual(stage.changes()[0].before, null, 'before must stay the ORIGINAL disk state');
  });

  await ok('a second brain reads the first brain’s staged file', async () => {
    const root = tempDir();
    const staging = new StagingWorkspace(root);
    staging.commit(
      { kind: 'write', path: path.join(root, 'api/a.ts'), relPath: 'api/a.ts', before: null, after: 'from-backend' },
      'backend',
      't1',
      0.8
    );
    const stage = new BrainStage(staging, 'frontend', 't2');
    const dispatch = createBrainDispatch({
      brain: brain({ id: 'frontend', contextRules: { ...brain().contextRules, include: ['**/*'] } }),
      stage,
      workspaceRoot: root,
      base: async () => 'DISK',
    });
    const out = await dispatch('read_file', { path: 'api/a.ts' }, {});
    assert.ok(out.includes('from-backend'), out);
  });

  console.log('brains — conflicts');

  await ok('disjoint edits to one base merge', () => {
    const base = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const theirs = ['a', 'B!', 'c', 'd', 'e'].join('\n');
    const mine = ['a', 'b', 'c', 'D!', 'e'].join('\n');
    assert.strictEqual(mergeDisjoint(base, theirs, mine), ['a', 'B!', 'c', 'D!', 'e'].join('\n'));
  });

  await ok('overlapping edits refuse to merge rather than guess', () => {
    const base = ['a', 'b', 'c'].join('\n');
    assert.strictEqual(mergeDisjoint(base, 'a\nX\nc', 'a\nY\nc'), null);
  });

  await ok('an edit on top of the current staged state is a fast-forward, not a conflict', () => {
    const root = tempDir();
    const staging = new StagingWorkspace(root);
    const first = { kind: 'write', path: path.join(root, 'a.ts'), relPath: 'a.ts', before: null, after: 'v1' };
    staging.commit(first as any, 'backend', 't1', 0.7);

    const resolver = new ConflictResolver();
    const result = resolver.commit(
      staging,
      proposal({
        brainId: 'frontend',
        changes: [{ kind: 'edit', path: first.path, relPath: 'a.ts', before: 'v1', after: 'v2' }],
      }),
      't2'
    );
    assert.strictEqual(result.conflicts.length, 0);
    assert.strictEqual(staging.read('a.ts'), 'v2');
  });

  await ok('a genuinely overlapping rewrite is reported and the confident brain wins', () => {
    const root = tempDir();
    const staging = new StagingWorkspace(root);
    staging.commit(
      { kind: 'write', path: path.join(root, 'a.ts'), relPath: 'a.ts', before: null, after: 'X' } as any,
      'backend',
      't1',
      0.4
    );

    const result = new ConflictResolver().commit(
      staging,
      proposal({
        brainId: 'frontend',
        confidence: 0.9,
        changes: [{ kind: 'write', path: path.join(root, 'a.ts'), relPath: 'a.ts', before: null, after: 'Y' }],
      }),
      't2'
    );
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].resolution, 'unresolved');
    assert.strictEqual(staging.read('a.ts'), 'Y', 'the more confident brain wins');
  });

  console.log('brains — report parsing');

  await ok('a fenced report block is parsed', () => {
    const r = parseReport('some prose\n```json\n{"summary":"did it","confidence":0.8,"pros":["fast"]}\n```');
    assert.strictEqual(r.summary, 'did it');
    assert.strictEqual(r.confidence, 0.8);
    assert.deepStrictEqual(r.pros, ['fast']);
  });

  await ok('braces inside a JSON string do not confuse extraction', () => {
    const json = extractJson('text {"summary":"use { and } here","confidence":0.5}');
    assert.ok(json && json.startsWith('{"summary"'), String(json));
    assert.strictEqual(JSON.parse(json!).confidence, 0.5);
  });

  await ok('the LAST balanced object wins, so a code sample earlier in the reply loses', () => {
    const r = parseReport('example: {"not":"the report"}\nand then\n{"summary":"real","confidence":0.9}');
    assert.strictEqual(r.summary, 'real');
  });

  await ok('a reply with no report block degrades instead of throwing', () => {
    const r = parseReport('no json at all here');
    assert.strictEqual(r.summary, '');
    assert.strictEqual(r.confidence, 0.5);
  });

  console.log('brains — consensus');

  await ok('review scores on a 0–10 or 0–100 scale are normalised', () => {
    const reviews = parseReviews(
      '{"reviews":[{"key":"k1","quality":8,"security":90,"performance":0.5,"architecture":1,"tests":0,"verdict":"accept","comment":"c"}]}',
      new Set(['k1'])
    );
    assert.strictEqual(reviews.length, 1);
    assert.ok(Math.abs(reviews[0].quality - 0.8) < 1e-9);
    assert.ok(Math.abs(reviews[0].security - 0.9) < 1e-9);
  });

  await ok('a score for an unknown proposal is discarded', () => {
    assert.strictEqual(parseReviews('{"reviews":[{"key":"ghost","quality":1}]}', new Set(['k1'])).length, 0);
  });

  await ok('a rejected proposal cannot win on cost or confidence', () => {
    const engine = new ConsensusEngine({ runner: null, registry: null, bus: new ConversationBus() });
    const cheap = proposal({ key: 'cheap', confidence: 1, costUsd: 0.0001, latencyMs: 10 });
    const good = proposal({ key: 'good', confidence: 0.5, costUsd: 5, latencyMs: 90_000 });
    const result = engine.score([cheap, good], [
      { proposalKey: 'cheap', quality: 0.9, security: 0.9, performance: 0.9, architecture: 0.9, tests: 0.9, verdict: 'reject', comment: '' },
      { proposalKey: 'good', quality: 0.6, security: 0.6, performance: 0.6, architecture: 0.6, tests: 0.6, verdict: 'accept', comment: '' },
    ]);
    assert.strictEqual(result.winner.key, 'good');
  });

  await ok('consensus is not a vote — two agreeing weak proposals lose to one strong one', () => {
    const engine = new ConsensusEngine({ runner: null, registry: null, bus: new ConversationBus() });
    const weakA = proposal({ key: 'a', confidence: 0.9 });
    const weakB = proposal({ key: 'b', confidence: 0.9 });
    const strong = proposal({ key: 'c', confidence: 0.5, evidence: ['x.ts:1', 'y.ts:2', 'z.ts:3', 'w.ts:4'] });
    const weakReview = (key: string) => ({
      proposalKey: key, quality: 0.3, security: 0.3, performance: 0.3, architecture: 0.3, tests: 0.3,
      verdict: 'revise' as const, comment: '',
    });
    const result = engine.score([weakA, weakB, strong], [
      weakReview('a'),
      weakReview('b'),
      { proposalKey: 'c', quality: 0.95, security: 0.95, performance: 0.9, architecture: 0.95, tests: 0.9, verdict: 'accept', comment: '' },
    ]);
    assert.strictEqual(result.winner.key, 'c');
  });

  await ok('a single proposal short-circuits scoring', () => {
    const engine = new ConsensusEngine({ runner: null, registry: null, bus: new ConversationBus() });
    assert.strictEqual(engine.score([proposal()], []).winner.key, 't1#backend');
  });

  await ok('a decision block is parsed', () => {
    assert.deepStrictEqual(parseDecision('```json\n{"winner":"k2","rationale":"why"}\n```'), {
      winner: 'k2',
      rationale: 'why',
    });
  });

  console.log('brains — memory');

  await ok('private memory is invisible to other brains', () => {
    const memory = new MemoryManager(new InMemoryPersistence(), 100);
    memory.remember('private', 'backend', 'backend-secret');
    memory.remember('shared', 'backend', 'team-note');

    const seenByFrontend = memory.recall(brain({ id: 'frontend' })).map((e: any) => e.text);
    assert.ok(!seenByFrontend.includes('backend-secret'));
    assert.ok(seenByFrontend.includes('team-note'));

    const seenByBackend = memory.recall(brain({ id: 'backend' })).map((e: any) => e.text);
    assert.ok(seenByBackend.includes('backend-secret'));
  });

  await ok('a brain that does not read shared memory gets none of it', () => {
    const memory = new MemoryManager(new InMemoryPersistence(), 100);
    memory.remember('shared', 'backend', 'team-note');
    const isolated = brain({ id: 'x', memory: { private: true, readsShared: false, writesShared: false, workspace: false } });
    assert.strictEqual(memory.recall(isolated).length, 0);
    assert.strictEqual(memory.render(isolated), '');
  });

  await ok('workspace memory survives clearSession, everything else does not', () => {
    const memory = new MemoryManager(new InMemoryPersistence(), 100);
    memory.remember('session', 'a', 'session-note');
    memory.remember('workspace', 'a', 'workspace-note');
    memory.clearSession();
    const b = brain({ id: 'a', memory: { private: true, readsShared: true, writesShared: true, workspace: true } });
    const texts = memory.recall(b).map((e: any) => e.text);
    assert.deepStrictEqual(texts, ['workspace-note']);
  });

  await ok('a keyed write replaces rather than accumulates', () => {
    const memory = new MemoryManager(new InMemoryPersistence(), 100);
    memory.remember('shared', 'a', 'v1', 'k');
    memory.remember('shared', 'a', 'v2', 'k');
    assert.strictEqual(memory.all().length, 1);
    assert.strictEqual(memory.all()[0].text, 'v2');
  });

  await ok('memory is bounded — the oldest entries are evicted', () => {
    const memory = new MemoryManager(new InMemoryPersistence(), 3);
    for (let i = 0; i < 10; i++) {
      memory.remember('shared', 'a', `n${i}`);
    }
    assert.strictEqual(memory.all().length, 3);
    assert.strictEqual(memory.all()[0].text, 'n7');
  });

  console.log('brains — registry');

  await ok('the built-in team loads and the planner cannot write files', () => {
    const registry = new BrainRegistry(() => ({ ...ORCHESTRATION_DEFAULTS, brainRoots: [] }));
    assert.ok(registry.all().length >= 11, `expected the full default team, got ${registry.all().length}`);
    const planner = registry.byRole('planner');
    assert.ok(planner);
    for (const tool of ['write_file', 'edit_file', 'delete_item', 'run_command']) {
      assert.ok(!toolAllowed(planner, tool), `planner must not be able to call ${tool}`);
    }
  });

  await ok('an installed brain pack is discovered from disk', () => {
    const root = tempDir();
    const dir = path.join(root, 'laravel');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'brain.json'),
      JSON.stringify({ id: 'laravel', name: 'Laravel Brain', role: 'backend', description: 'PHP', model: 'x-model' })
    );
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'You are the Laravel brain.');
    fs.writeFileSync(
      path.join(dir, 'capabilities.json'),
      JSON.stringify({ tools: { allow: ['read_file'], deny: [] }, contextRules: { include: ['app/**'] } })
    );

    const registry = new BrainRegistry(() => ({ ...ORCHESTRATION_DEFAULTS, brainRoots: [root] }));
    const laravel = registry.get('laravel');
    assert.ok(laravel, 'the pack should be registered');
    assert.strictEqual(laravel.name, 'Laravel Brain');
    assert.strictEqual(laravel.model, 'x-model');
    assert.strictEqual(laravel.source, 'installed');
    assert.ok(laravel.systemPrompt.includes('Laravel'));
    assert.deepStrictEqual(laravel.contextRules.include, ['app/**']);
    assert.ok(!toolAllowed(laravel, 'write_file'));
  });

  await ok('a malformed pack is reported, not fatal', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'broken', 'brain.json'), '{ not json');
    const registry = new BrainRegistry(() => ({ ...ORCHESTRATION_DEFAULTS, brainRoots: [root] }));
    assert.ok(registry.all().length >= 11, 'the default team must survive a broken pack');
    assert.strictEqual(registry.getProblems().length, 1);
  });

  await ok('a settings override wins over the definition', () => {
    const registry = new BrainRegistry(() => ({
      ...ORCHESTRATION_DEFAULTS,
      brainRoots: [],
      overrides: { backend: { enabled: false, model: 'my-model', temperature: 0.9 } },
    }));
    const backend = registry.get('backend');
    assert.strictEqual(backend.enabled, false);
    assert.strictEqual(backend.model, 'my-model');
    assert.strictEqual(backend.temperature, 0.9);
    assert.ok(!registry.enabled().some((b: any) => b.id === 'backend'));
  });

  await ok('a hallucinated brain name resolves by role and by fuzzy id', () => {
    const registry = new BrainRegistry(() => ({ ...ORCHESTRATION_DEFAULTS, brainRoots: [] }));
    assert.strictEqual(registry.resolve('backend-engineer')?.id, 'backend');
    assert.strictEqual(registry.resolve('Security Engineer')?.id, 'security');
    assert.strictEqual(registry.resolve('database')?.id, 'database');
    assert.strictEqual(registry.resolve(''), undefined);
  });

  console.log('brains — DAG');

  await ok('a cycle is broken by dropping an edge, never a task', () => {
    const tasks = [
      { id: 'a', title: 'a', instruction: 'a', brainId: 'x', dependsOn: ['c'] },
      { id: 'b', title: 'b', instruction: 'b', brainId: 'x', dependsOn: ['a'] },
      { id: 'c', title: 'c', instruction: 'c', brainId: 'x', dependsOn: ['b'] },
    ];
    const fixed = breakCycles(tasks);
    assert.strictEqual(fixed.length, 3, 'no task may be lost');
    const order = topoOrder(fixed).map((t: any) => t.id);
    for (const task of fixed) {
      for (const dep of task.dependsOn) {
        assert.ok(order.indexOf(dep) < order.indexOf(task.id), `${dep} must precede ${task.id}`);
      }
    }
  });

  await ok('topological order puts every dependency first', () => {
    const tasks = [
      { id: 'ui', title: 'ui', instruction: '', brainId: 'x', dependsOn: ['api'] },
      { id: 'api', title: 'api', instruction: '', brainId: 'x', dependsOn: ['db'] },
      { id: 'db', title: 'db', instruction: '', brainId: 'x', dependsOn: [] },
    ];
    assert.deepStrictEqual(topoOrder(tasks).map((t: any) => t.id), ['db', 'api', 'ui']);
  });

  await ok('the planner repairs a model-authored plan', async () => {
    const registry = new BrainRegistry(() => ({ ...ORCHESTRATION_DEFAULTS, brainRoots: [] }));
    const raw = JSON.stringify({
      summary: 'plan',
      confidence: 0.9,
      tasks: [
        { id: 't1', title: 'schema', brain: 'database-engineer', instruction: 'users table', dependsOn: ['ghost'] },
        { id: 't2', title: 'api', brain: 'nonexistent-brain', instruction: 'routes', dependsOn: ['t1'] },
        { id: 't2', title: 'dup id', brain: 'frontend', instruction: 'login form', dependsOn: ['t2'] },
        { id: 't4', title: 'review', brain: 'reviewer', instruction: 'review it', dependsOn: [] },
        { title: 'no instruction or title text' },
      ],
    });
    const planner = new TaskPlanner({
      registry,
      runner: { run: async () => proposal({ raw, summary: 'plan' }) },
    });
    const { plan } = await planner.plan({
      goal: 'auth',
      staging: new StagingWorkspace(''),
      spentThisRun: 0,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });

    const ids = plan.tasks.map((t: any) => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids must be made unique');
    assert.strictEqual(plan.tasks[0].brainId, 'database', 'a near-miss brain name resolves');
    assert.deepStrictEqual(plan.tasks[0].dependsOn, [], 'a dependency on a task that does not exist is dropped');
    assert.ok(plan.tasks.every((t: any) => t.brainId !== 'reviewer'), 'review is automatic, never a planned task');
    assert.ok(plan.tasks.every((t: any) => t.instruction), 'every task must carry an instruction');
  });

  await ok('an unusable planner reply still produces a runnable single-task plan', async () => {
    const registry = new BrainRegistry(() => ({ ...ORCHESTRATION_DEFAULTS, brainRoots: [] }));
    const planner = new TaskPlanner({
      registry,
      runner: { run: async () => proposal({ raw: 'sorry, I cannot help', error: 'boom' }) },
    });
    const { plan } = await planner.plan({
      goal: 'build auth',
      staging: new StagingWorkspace(''),
      spentThisRun: 0,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    assert.strictEqual(plan.tasks.length, 1);
    assert.strictEqual(plan.tasks[0].instruction, 'build auth');
  });

  console.log('brains — scheduler');

  function fakeScheduler(behaviour: (taskId: string) => Partial<any>) {
    const registry = new BrainRegistry(() => ({ ...ORCHESTRATION_DEFAULTS, brainRoots: [] }));
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;

    const runner = {
      async run({ task }: any) {
        order.push(task.id);
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise(r => setTimeout(r, 15));
        concurrent--;
        return proposal({ key: `${task.id}#x`, taskId: task.id, ...behaviour(task.id) });
      },
    };
    const scheduler = new Scheduler({ runner, registry, bus: new ConversationBus() });
    return { scheduler, order, peak: () => peak };
  }

  await ok('dependencies are respected and independent tasks run together', async () => {
    const harness = fakeScheduler(() => ({}));
    const plan = {
      goal: 'g',
      tasks: [
        { id: 'db', title: 'db', instruction: 'i', brainId: 'database', dependsOn: [] },
        { id: 'api', title: 'api', instruction: 'i', brainId: 'backend', dependsOn: ['db'] },
        { id: 'ui', title: 'ui', instruction: 'i', brainId: 'frontend', dependsOn: ['db'] },
        { id: 'docs', title: 'docs', instruction: 'i', brainId: 'documentation', dependsOn: ['api', 'ui'] },
      ],
    };
    const result = await harness.scheduler.execute({
      plan,
      staging: new StagingWorkspace(tempDir()),
      goal: 'g',
      maxConcurrent: 4,
      timeoutMs: 5000,
      retries: 0,
      debateFor: () => 1,
      signal: new AbortController().signal,
      spent: () => 0,
      settle: async (_t: any, ps: any[]) => ps[0],
      onStatus: () => undefined,
      onProposal: () => undefined,
    });

    assert.strictEqual(harness.order[0], 'db');
    assert.strictEqual(harness.order[harness.order.length - 1], 'docs');
    assert.ok(harness.peak() >= 2, 'api and ui share no dependency, so they must overlap');
    assert.ok(result.statuses.every((s: any) => s.state === 'done'));
  });

  await ok('the concurrency cap is honoured', async () => {
    const harness = fakeScheduler(() => ({}));
    const plan = {
      goal: 'g',
      tasks: Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`, title: 't', instruction: 'i', brainId: 'backend', dependsOn: [],
      })),
    };
    await harness.scheduler.execute({
      plan,
      staging: new StagingWorkspace(tempDir()),
      goal: 'g',
      maxConcurrent: 2,
      timeoutMs: 5000,
      retries: 0,
      debateFor: () => 1,
      signal: new AbortController().signal,
      spent: () => 0,
      settle: async (_t: any, ps: any[]) => ps[0],
      onStatus: () => undefined,
      onProposal: () => undefined,
    });
    assert.ok(harness.peak() <= 2, `peak concurrency was ${harness.peak()}, cap was 2`);
  });

  await ok('a failed task skips its dependants instead of building on nothing', async () => {
    const harness = fakeScheduler(id => (id === 'db' ? { error: 'provider down' } : {}));
    const plan = {
      goal: 'g',
      tasks: [
        { id: 'db', title: 'db', instruction: 'i', brainId: 'database', dependsOn: [] },
        { id: 'api', title: 'api', instruction: 'i', brainId: 'backend', dependsOn: ['db'] },
        { id: 'solo', title: 'solo', instruction: 'i', brainId: 'frontend', dependsOn: [] },
      ],
    };
    const result = await harness.scheduler.execute({
      plan,
      staging: new StagingWorkspace(tempDir()),
      goal: 'g',
      maxConcurrent: 3,
      timeoutMs: 5000,
      retries: 0,
      debateFor: () => 1,
      signal: new AbortController().signal,
      spent: () => 0,
      settle: async (_t: any, ps: any[]) => ps[0],
      onStatus: () => undefined,
      onProposal: () => undefined,
    });

    const state = (id: string) => result.statuses.find((s: any) => s.taskId === id).state;
    assert.strictEqual(state('db'), 'failed');
    assert.strictEqual(state('api'), 'skipped');
    assert.strictEqual(state('solo'), 'done', 'an unrelated task must still run');
    assert.ok(!harness.order.includes('api'), 'a skipped task must never reach a brain');
  });

  await ok('debate runs several brains on one task and hands them all to settle', async () => {
    const harness = fakeScheduler(() => ({}));
    let seen = 0;
    await harness.scheduler.execute({
      plan: { goal: 'g', tasks: [{ id: 't1', title: 't', instruction: 'i', brainId: 'backend', dependsOn: [] }] },
      staging: new StagingWorkspace(tempDir()),
      goal: 'g',
      maxConcurrent: 4,
      timeoutMs: 5000,
      retries: 0,
      debateFor: () => 3,
      signal: new AbortController().signal,
      spent: () => 0,
      settle: async (_t: any, ps: any[]) => {
        seen = ps.length;
        return ps[0];
      },
      onStatus: () => undefined,
      onProposal: () => undefined,
    });
    assert.strictEqual(seen, 3);
  });

  console.log('brains — executor');

  await ok('a change set is written, creating parent folders', async () => {
    const root = tempDir();
    const target = path.join(root, 'a', 'b', 'new.ts');
    const outcome = await new Executor().apply([
      { kind: 'write', path: target, relPath: 'a/b/new.ts', before: null, after: 'hello' },
    ]);
    assert.strictEqual(outcome.applied.length, 1);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
  });

  await ok('a file the user changed after staging is SKIPPED, never overwritten', async () => {
    const root = tempDir();
    const target = path.join(root, 'edited.ts');
    fs.writeFileSync(target, 'user typed this');

    const outcome = await new Executor().apply([
      { kind: 'edit', path: target, relPath: 'edited.ts', before: 'what the brain read', after: 'brain output' },
    ]);
    assert.strictEqual(outcome.applied.length, 0);
    assert.strictEqual(outcome.skipped.length, 1);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'user typed this', 'the user’s work must survive');
  });

  await ok('a file already in the target state is not a failure', async () => {
    const root = tempDir();
    const target = path.join(root, 'same.ts');
    fs.writeFileSync(target, 'final');
    const outcome = await new Executor().apply([
      { kind: 'edit', path: target, relPath: 'same.ts', before: 'old', after: 'final' },
    ]);
    assert.strictEqual(outcome.applied.length, 1);
  });

  await ok('a rejected change is skipped and the rest still apply', async () => {
    const root = tempDir();
    const a = path.join(root, 'a.ts');
    const b = path.join(root, 'b.ts');
    const outcome = await new Executor(async (change: any) => ({ approved: change.relPath === 'b.ts' })).apply([
      { kind: 'write', path: a, relPath: 'a.ts', before: null, after: 'A' },
      { kind: 'write', path: b, relPath: 'b.ts', before: null, after: 'B' },
    ]);
    assert.strictEqual(outcome.applied.length, 1);
    assert.strictEqual(outcome.skipped.length, 1);
    assert.ok(!fs.existsSync(a));
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'B');
  });

  await ok('a delete goes to the trash, not to oblivion', async () => {
    const root = tempDir();
    const target = path.join(root, 'gone.ts');
    fs.writeFileSync(target, 'bye');
    trashed.length = 0;
    const outcome = await new Executor().apply([
      { kind: 'delete', path: target, relPath: 'gone.ts', before: 'bye', after: null },
    ]);
    assert.strictEqual(outcome.applied.length, 1);
    assert.deepStrictEqual(trashed, [target]);
  });

  await ok('changeSetStat counts added and removed lines', () => {
    const stat = changeSetStat([
      { kind: 'edit', path: 'p', relPath: 'p', before: 'a\nb\nc', after: 'a\nB\nc\nd' },
    ]);
    assert.strictEqual(stat.files, 1);
    assert.strictEqual(stat.added, 2);
    assert.strictEqual(stat.removed, 1);
  });

  console.log('brains — cost');

  await ok('cost is estimated per million tokens', () => {
    const price = priceOf('anthropic/claude-sonnet-4');
    assert.strictEqual(price.in, 3);
    const cost = estimateCost('anthropic/claude-sonnet-4', 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - 18) < 1e-9, String(cost));
  });

  await ok('an unknown (local) model is free', () => {
    assert.strictEqual(estimateCost('my-local-ollama-model', 1e6, 1e6), 0);
  });

  console.log('brains — bus');

  await ok('subscribers see messages and a broken subscriber does not stop the rest', () => {
    const bus = new ConversationBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('broken subscriber');
    });
    bus.subscribe((m: any) => seen.push(m.subject));
    bus.publish({ type: 'task', from: 'orchestrator', subject: 'one', body: '' });
    bus.publish({ type: 'proposal', from: 'backend', taskId: 't1', subject: 'two', body: '' });
    assert.deepStrictEqual(seen, ['one', 'two']);
    assert.strictEqual(bus.history({ type: 'proposal' }).length, 1);
    assert.strictEqual(bus.history({ taskId: 't1' }).length, 1);
  });

  // ── done ────────────────────────────────────────────────────────────────
  for (const dir of temps) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} check(s) passed.`);
}

void main();
