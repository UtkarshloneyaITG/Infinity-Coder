import { BrainRegistry } from './registry';
import { BrainRunner } from './runner';
import { StagingWorkspace } from './staging';
import { ConversationBus } from './bus';
import { topoOrder } from './planner';
import { ChatStreamEvent } from '../types';
import { FileChange, Plan, Proposal, Task, TaskStatus } from './types';

/**
 * The Scheduler — runs the DAG.
 *
 * A task becomes runnable when every task it depends on has finished. Runnable
 * tasks are started up to the concurrency cap, highest brain priority first, and
 * anything that does not fit waits in the queue. Everything else — what a task
 * means, whether its output is any good, where its files go — belongs to other
 * modules; this one only decides what runs when.
 *
 * Concurrency is capped because the limit here is provider rate limits, not CPU.
 * Twelve brains firing at one API key gets eleven 429s and one answer.
 */

export interface SchedulerDeps {
  runner: BrainRunner;
  registry: BrainRegistry;
  bus: ConversationBus;
}

export interface ExecuteOptions {
  plan: Plan;
  staging: StagingWorkspace;
  goal: string;
  maxConcurrent: number;
  timeoutMs: number;
  retries: number;
  /** How many brains attempt each task independently. 1 = no debate. */
  debateFor: (task: Task) => number;
  signal: AbortSignal;
  /** Total USD spent so far, for budget-aware routing. */
  spent: () => number;
  /**
   * Settle a finished task: pick between debate variants, resolve conflicts and
   * commit the winner's changes into the shared staging workspace. Returns the
   * proposal that actually won, or null if nothing was usable.
   */
  settle: (task: Task, proposals: Proposal[]) => Promise<Proposal | null>;
  onStatus: (status: TaskStatus) => void;
  onProposal: (proposal: Proposal) => void;
  onStage?: (change: FileChange) => void;
  onStream?: (task: Task, event: ChatStreamEvent) => void;
}

export interface ExecuteResult {
  proposals: Proposal[];
  statuses: TaskStatus[];
  /** The winning proposal per task id. */
  winners: Map<string, Proposal>;
}

export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  public async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const tasks = topoOrder(options.plan.tasks);
    const statuses = new Map<string, TaskStatus>();
    const proposals: Proposal[] = [];
    const winners = new Map<string, Proposal>();

    for (const task of tasks) {
      statuses.set(task.id, {
        taskId: task.id,
        state: 'pending',
        brainId: task.brainId,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      });
    }

    const setState = (task: Task, patch: Partial<TaskStatus>): TaskStatus => {
      const status = { ...statuses.get(task.id)!, ...patch };
      statuses.set(task.id, status);
      options.onStatus(status);
      return status;
    };

    const done = new Set<string>();
    const failed = new Set<string>();
    const running = new Map<string, Promise<void>>();
    /** True while a brain that refuses to share the machine is running. */
    let exclusiveBusy = false;

    const remaining = () => tasks.filter(t => !done.has(t.id) && !failed.has(t.id) && !running.has(t.id));

    const readyNow = (): Task[] =>
      remaining()
        .filter(t => t.dependsOn.every(d => done.has(d) || failed.has(d)))
        .sort((a, b) => {
          const pa = this.deps.registry.get(a.brainId)?.priority ?? 50;
          const pb = this.deps.registry.get(b.brainId)?.priority ?? 50;
          return pb - pa;
        });

    const startTask = (task: Task): Promise<void> => {
      const brain = this.deps.registry.get(task.brainId);
      const debate = Math.max(1, Math.min(5, options.debateFor(task)));

      // A dependency that failed means this task's premise is gone. Running it
      // anyway produces confident work on top of something that does not exist.
      const brokenDep = task.dependsOn.find(d => failed.has(d));
      if (!brain || !brain.enabled || brokenDep) {
        failed.add(task.id);
        setState(task, {
          state: 'skipped',
          note: !brain
            ? `Brain '${task.brainId}' is not installed.`
            : !brain.enabled
              ? `${brain.name} is disabled in settings.`
              : `Skipped — it depends on ${brokenDep}, which did not complete.`,
        });
        return Promise.resolve();
      }

      setState(task, { state: 'running', startedAt: Date.now() });
      this.deps.bus.publish({
        type: 'task',
        from: 'orchestrator',
        to: brain.id,
        taskId: task.id,
        subject: task.title,
        body: task.instruction,
      });

      const attempt = async (): Promise<Proposal[]> => {
        const variants = debate > 1 ? Array.from({ length: debate }, (_, i) => i + 1) : [undefined];
        return Promise.all(
          variants.map(variant =>
            this.deps.runner.run({
              task,
              brain,
              staging: options.staging,
              goal: options.goal,
              variant,
              spentThisRun: options.spent(),
              timeoutMs: options.timeoutMs,
              signal: options.signal,
              onStage: options.onStage,
              onStream: options.onStream ? event => options.onStream!(task, event) : undefined,
            })
          )
        );
      };

      const work = (async () => {
        let results: Proposal[] = [];
        for (let tryIndex = 0; tryIndex <= options.retries; tryIndex++) {
          results = await attempt();
          // Retry only a total wipeout. A partial result is information, and a
          // second run costs as much as the first.
          if (options.signal.aborted || results.some(p => !p.error)) {
            break;
          }
          if (tryIndex < options.retries) {
            this.deps.bus.publish({
              type: 'status',
              from: 'orchestrator',
              taskId: task.id,
              subject: `Retrying ${task.title}`,
              body: results[0]?.error || 'The brain returned nothing usable.',
            });
          }
        }

        proposals.push(...results);
        for (const p of results) {
          options.onProposal(p);
        }

        const usable = results.filter(p => !p.error);
        const spentHere = results.reduce((n, p) => n + p.costUsd, 0);
        const tokensIn = results.reduce((n, p) => n + p.tokensIn, 0);
        const tokensOut = results.reduce((n, p) => n + p.tokensOut, 0);

        if (options.signal.aborted) {
          failed.add(task.id);
          setState(task, { state: 'cancelled', finishedAt: Date.now(), costUsd: spentHere, tokensIn, tokensOut });
          return;
        }

        if (usable.length === 0) {
          const note = results[0]?.error || 'No usable result.';
          if (task.optional) {
            done.add(task.id); // optional: does not poison its dependants
          } else {
            failed.add(task.id);
          }
          setState(task, {
            state: task.optional ? 'skipped' : 'failed',
            finishedAt: Date.now(),
            note,
            costUsd: spentHere,
            tokensIn,
            tokensOut,
          });
          return;
        }

        const winner = await options.settle(task, usable);
        if (winner) {
          winners.set(task.id, winner);
        }
        done.add(task.id);
        setState(task, {
          state: 'done',
          finishedAt: Date.now(),
          provider: winner?.provider,
          model: winner?.model,
          confidence: winner?.confidence,
          costUsd: spentHere,
          tokensIn,
          tokensOut,
        });
      })();

      return work;
    };

    // ── the pump ──────────────────────────────────────────────────────────
    while (remaining().length > 0 || running.size > 0) {
      if (options.signal.aborted) {
        for (const task of remaining()) {
          failed.add(task.id);
          setState(task, { state: 'cancelled' });
        }
        break;
      }

      let started = false;
      for (const task of readyNow()) {
        if (running.size >= Math.max(1, options.maxConcurrent)) {
          break;
        }
        const brain = this.deps.registry.get(task.brainId);
        const exclusive = brain ? !brain.parallelExecution : false;
        // An exclusive brain (the Reviewer, the Consensus brain) gets the machine
        // to itself: its whole job is judging a settled state, and starting new
        // work underneath it means judging a moving target.
        if (exclusiveBusy || (exclusive && running.size > 0)) {
          continue;
        }
        if (exclusive) {
          exclusiveBusy = true;
        }

        const promise = startTask(task).finally(() => {
          running.delete(task.id);
          if (exclusive) {
            exclusiveBusy = false;
          }
        });
        running.set(task.id, promise);
        started = true;
      }

      if (running.size === 0 && !started) {
        // Nothing running and nothing startable: every remaining task is blocked
        // behind a dependency that failed. Mark them and stop, rather than spin.
        for (const task of remaining()) {
          failed.add(task.id);
          setState(task, { state: 'skipped', note: 'Blocked by an earlier failure.' });
        }
        break;
      }

      await Promise.race(running.values());
    }

    await Promise.allSettled(running.values());
    return { proposals, statuses: [...statuses.values()], winners };
  }
}
