import { BrainRegistry } from './registry';
import { BrainRunner, extractJson } from './runner';
import { StagingWorkspace } from './staging';
import { BrainDef, Plan, Proposal, Task } from './types';

/**
 * The Task Planner — turns a sentence into a dependency graph.
 *
 * The Planner brain proposes; this module decides what is actually runnable.
 * A model-authored plan is untrusted input: it names brains that do not exist,
 * depends on tasks it never declared, and occasionally builds a cycle. All of
 * that is repaired here rather than surfaced as an error, because a plan is
 * expensive and a slightly-wrong one is nearly always salvageable.
 */

const PLANNER_INSTRUCTION = `
Break the goal below into the smallest set of tasks that genuinely delivers it.

Assign each task to exactly ONE brain, by id, from the team roster provided.
Declare dependencies honestly: a task lists ONLY the tasks whose output it truly
needs. Tasks with no dependency between them run in parallel, so a dependency
you add "to be safe" costs real wall-clock time.

Include your task list in the JSON block as a "tasks" array, alongside the
normal summary fields:

"tasks": [
  {
    "id": "t1",
    "title": "short imperative title",
    "brain": "brain id from the roster",
    "instruction": "what this brain must do, naming the files or modules involved",
    "acceptance": "how the reviewer will know it is done",
    "dependsOn": []
  }
]

Rules:
- 2 to 8 tasks. Fewer, sharper tasks beat many vague ones.
- Every id in dependsOn must be a task id you also defined.
- No cycles.
- Do not assign a task to the planner, the reviewer or the consensus brain —
  review and consensus happen automatically after your tasks finish.
`.trim();

export interface PlannerDeps {
  runner: BrainRunner;
  registry: BrainRegistry;
}

export class TaskPlanner {
  constructor(private readonly deps: PlannerDeps) {}

  public async plan(options: {
    goal: string;
    staging: StagingWorkspace;
    spentThisRun: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ plan: Plan; proposal?: Proposal }> {
    const planner = this.deps.registry.byRole('planner');
    if (!planner) {
      return { plan: this.fallbackPlan(options.goal, 'No planner brain is enabled.') };
    }

    const roster = this.roster();
    const task: Task = {
      id: 'plan',
      title: 'Plan the work',
      brainId: planner.id,
      dependsOn: [],
      instruction: `${PLANNER_INSTRUCTION}\n\nTEAM ROSTER:\n${roster}`,
    };

    const proposal = await this.deps.runner.run({
      task,
      brain: planner,
      staging: options.staging,
      goal: options.goal,
      spentThisRun: options.spentThisRun,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    const tasks = this.parseTasks(proposal.raw);
    if (tasks.length === 0) {
      return {
        plan: this.fallbackPlan(
          options.goal,
          proposal.error
            ? `Planning failed (${proposal.error}), so the goal is being handled as a single task.`
            : 'The planner returned no usable task list, so the goal is being handled as a single task.'
        ),
        proposal,
      };
    }

    return {
      plan: { goal: options.goal, tasks, notes: proposal.summary },
      proposal,
    };
  }

  /** The roster the planner assigns from — enabled engineers only. */
  private roster(): string {
    const excluded = new Set(['planner', 'reviewer', 'consensus']);
    return this.deps.registry
      .enabled()
      .filter(b => !excluded.has(b.role))
      .map(b => `- ${b.id} (${b.name}): ${b.description}`)
      .join('\n');
  }

  private parseTasks(raw: string): Task[] {
    const json = extractJson(raw || '');
    if (!json) {
      return [];
    }
    let obj: any;
    try {
      obj = JSON.parse(json);
    } catch {
      try {
        obj = JSON.parse(json.replace(/,(\s*[}\]])/g, '$1'));
      } catch {
        return [];
      }
    }
    if (!obj || !Array.isArray(obj.tasks)) {
      return [];
    }
    return this.normalize(obj.tasks);
  }

  /**
   * Repair a model-authored task list into something the scheduler can run.
   * Every step here exists because a model got it wrong in practice.
   */
  private normalize(rawTasks: any[]): Task[] {
    const excluded = new Set(['planner', 'reviewer', 'consensus']);
    const fallbackBrain =
      this.deps.registry.enabled().find(b => !excluded.has(b.role)) || this.deps.registry.enabled()[0];
    if (!fallbackBrain) {
      return [];
    }

    // Pass 1: shape, ids, brains.
    const seen = new Set<string>();
    const tasks: Task[] = [];
    for (const [index, raw] of rawTasks.slice(0, 24).entries()) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const instruction = text(raw.instruction) || text(raw.description) || text(raw.title);
      if (!instruction) {
        continue;
      }
      let id = text(raw.id) || `t${index + 1}`;
      while (seen.has(id)) {
        id = `${id}b`;
      }
      seen.add(id);

      const named = text(raw.brain) || text(raw.brainId) || text(raw.role);
      const resolved = this.deps.registry.resolve(named);
      // A reviewer or consensus assignment is the planner duplicating machinery
      // that already runs after every plan, so it is redirected rather than run.
      const brain: BrainDef =
        resolved && resolved.enabled && !excluded.has(resolved.role) ? resolved : fallbackBrain;

      tasks.push({
        id,
        title: text(raw.title) || instruction.slice(0, 60),
        instruction,
        brainId: brain.id,
        dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(text).filter(Boolean) : [],
        acceptance: text(raw.acceptance) || undefined,
        optional: raw.optional === true,
      });
    }

    // Pass 2: dependencies must point at tasks that exist and not at themselves.
    const ids = new Set(tasks.map(t => t.id));
    for (const t of tasks) {
      t.dependsOn = [...new Set(t.dependsOn.filter(d => d !== t.id && ids.has(d)))];
    }

    return breakCycles(tasks);
  }

  /** One task, one brain, when planning could not produce anything usable. */
  private fallbackPlan(goal: string, note: string): Plan {
    const brain =
      this.deps.registry.byRole('backend') ||
      this.deps.registry.byRole('architect') ||
      this.deps.registry.enabled()[0];
    if (!brain) {
      return { goal, tasks: [], notes: 'No brains are enabled.' };
    }
    return {
      goal,
      notes: note,
      tasks: [
        {
          id: 't1',
          title: goal.slice(0, 60),
          instruction: goal,
          brainId: brain.id,
          dependsOn: [],
        },
      ],
    };
  }
}

/**
 * Remove the smallest set of edges that makes the graph acyclic, keeping every
 * task. Dropping a dependency runs a task earlier than intended; dropping a task
 * loses work outright — so this drops edges.
 */
export function breakCycles(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, stack: string[]): void => {
    const current = state.get(id);
    if (current === 'done') {
      return;
    }
    if (current === 'visiting') {
      return;
    }
    state.set(id, 'visiting');
    const task = byId.get(id);
    if (task) {
      for (const dep of [...task.dependsOn]) {
        if (state.get(dep) === 'visiting' || stack.includes(dep)) {
          // `dep` is an ancestor of this task: the edge closes a loop.
          task.dependsOn = task.dependsOn.filter(d => d !== dep);
          continue;
        }
        visit(dep, [...stack, id]);
      }
    }
    state.set(id, 'done');
  };

  for (const task of tasks) {
    visit(task.id, []);
  }
  return tasks;
}

/** Tasks in an order where every dependency precedes its dependants. */
export function topoOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out: Task[] = [];
  const emitted = new Set<string>();

  // Kahn's algorithm, taking ready tasks in declaration order so a plan reads
  // the way the planner wrote it when nothing forces otherwise.
  let progress = true;
  while (out.length < tasks.length && progress) {
    progress = false;
    for (const task of tasks) {
      if (emitted.has(task.id)) {
        continue;
      }
      if (task.dependsOn.every(d => emitted.has(d) || !byId.has(d))) {
        out.push(task);
        emitted.add(task.id);
        progress = true;
      }
    }
  }
  // Anything left is in a cycle breakCycles missed; append it rather than lose it.
  for (const task of tasks) {
    if (!emitted.has(task.id)) {
      out.push(task);
    }
  }
  return out;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
