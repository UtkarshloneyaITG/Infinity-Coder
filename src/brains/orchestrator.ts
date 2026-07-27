import { BrainRegistry } from './registry';
import { BrainRunner } from './runner';
import { TaskPlanner } from './planner';
import { Scheduler } from './scheduler';
import { ConsensusEngine } from './consensus';
import { ConflictResolver } from './conflicts';
import { Executor, ChangeApprover } from './executor';
import { ProviderRouter } from './router';
import { MemoryManager } from './memory';
import { ConversationBus } from './bus';
import { StagingWorkspace } from './staging';
import {
  Conflict,
  ConsensusResult,
  FileChange,
  OrchestrationSettings,
  OrchestratorOptions,
  Proposal,
  ReviewScore,
  RunSummary,
  Task,
} from './types';

/**
 * The Orchestrator — the conductor, and the Decision Engine.
 *
 * It owns the run's lifecycle and nothing else: plan, schedule, settle each
 * task, review the whole, then hand a single reviewed change set to the user.
 * Every decision inside those phases belongs to an injected collaborator, which
 * is what lets any of them be replaced without touching this file.
 *
 * Nothing is written to disk until `apply()` is called with the user's
 * approval — a run that is cancelled, fails, or is rejected leaves the working
 * tree byte-for-byte as it was.
 */

export interface OrchestratorDeps {
  registry: BrainRegistry;
  runner: BrainRunner;
  planner: TaskPlanner;
  scheduler: Scheduler;
  consensus: ConsensusEngine;
  conflicts: ConflictResolver;
  router: ProviderRouter;
  memory: MemoryManager;
  bus: ConversationBus;
  readSettings: () => OrchestrationSettings;
}

let runCounter = 0;

export class Orchestrator {
  private current: RunSummary | undefined;
  private staging: StagingWorkspace | undefined;

  constructor(private readonly deps: OrchestratorDeps) {}

  public getCurrentRun(): RunSummary | undefined {
    return this.current;
  }

  public async run(options: OrchestratorOptions): Promise<RunSummary> {
    const settings = this.deps.readSettings();
    const staging = new StagingWorkspace(options.workspaceRoot);
    this.staging = staging;
    this.deps.memory.clearRun();

    const summary: RunSummary = {
      runId: `run-${Date.now().toString(36)}-${++runCounter}`,
      goal: options.goal,
      plan: { goal: options.goal, tasks: [] },
      statuses: [],
      proposals: [],
      conflicts: [],
      changes: [],
      reviews: [],
      consensus: [],
      totalCostUsd: 0,
      totalTokens: 0,
      startedAt: Date.now(),
      state: 'planning',
    };
    this.current = summary;

    const emit = options.onEvent;
    const unsubscribe = this.deps.bus.subscribe(message => emit({ type: 'message', message }));
    const spend = (usd: number) => {
      summary.totalCostUsd += usd;
      this.deps.router.recordSpend(usd);
    };
    const spent = () => summary.totalCostUsd;

    emit({ type: 'run-started', runId: summary.runId, goal: options.goal });
    this.deps.bus.publish({
      type: 'task',
      from: 'user',
      subject: 'Goal',
      body: options.goal,
    });

    try {
      // ── 1. Plan ────────────────────────────────────────────────────────
      const { plan, proposal: planProposal } = await this.deps.planner.plan({
        goal: options.goal,
        staging,
        spentThisRun: spent(),
        timeoutMs: settings.brainTimeoutMs,
        signal: options.signal,
      });
      if (planProposal) {
        spend(planProposal.costUsd);
        summary.totalTokens += planProposal.tokensIn + planProposal.tokensOut;
      }
      summary.plan = plan;
      emit({ type: 'plan', plan });

      if (plan.tasks.length === 0) {
        summary.state = 'failed';
        summary.error = 'No brains are enabled, so there is nothing to run. Enable at least one in Settings → Brains.';
        summary.finishedAt = Date.now();
        emit({ type: 'run-finished', summary });
        return summary;
      }

      // ── 2. Execute the DAG ─────────────────────────────────────────────
      summary.state = 'running';
      const result = await this.deps.scheduler.execute({
        plan,
        staging,
        goal: options.goal,
        maxConcurrent: settings.maxConcurrentBrains,
        timeoutMs: settings.brainTimeoutMs,
        retries: settings.retriesPerTask,
        debateFor: task => this.debateSize(task, settings),
        signal: options.signal,
        spent,
        settle: (task, proposals) => this.settle(task, proposals, staging, summary, options, settings, spend),
        onStatus: status => emit({ type: 'task-state', status }),
        onProposal: proposal => {
          summary.proposals.push(proposal);
          summary.totalTokens += proposal.tokensIn + proposal.tokensOut;
          emit({ type: 'proposal', proposal });
        },
        onStage: change => emit({ type: 'log', text: `staged ${change.relPath}` }),
      });
      summary.statuses = result.statuses;

      if (options.signal.aborted) {
        summary.state = 'cancelled';
        // Tasks that finished before the stop have real, paid-for work staged.
        // It is still not applied — the user asked to stop — but it is handed
        // back rather than silently binned, so they can decide. A partial set is
        // genuinely risky (a migration written, the code using it not), which is
        // why this offers and never auto-applies.
        summary.changes = staging.changes();
        summary.finishedAt = Date.now();
        emit({ type: 'run-finished', summary });
        return summary;
      }

      // ── 3. Review the whole ────────────────────────────────────────────
      summary.state = 'reviewing';
      const winners = [...result.winners.values()];
      if (winners.length > 0) {
        const { reviews, cost } = await this.deps.consensus.review({
          proposals: winners,
          staging,
          goal: options.goal,
          spentThisRun: spent(),
          timeoutMs: settings.brainTimeoutMs,
          signal: options.signal,
        });
        spend(cost);
        summary.reviews.push(...reviews);
      }

      // ── 4. Hand over the change set ────────────────────────────────────
      summary.changes = staging.changes();
      summary.state = 'awaiting-approval';
      emit({ type: 'awaiting-approval', summary });

      if (this.shouldAutoApply(settings, summary)) {
        await this.apply(summary, options, undefined);
      }

      summary.finishedAt = Date.now();
      emit({ type: 'run-finished', summary });
      return summary;
    } catch (e: any) {
      summary.state = 'failed';
      summary.error = e?.message || String(e);
      summary.finishedAt = Date.now();
      emit({ type: 'run-finished', summary });
      return summary;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Settle one task: pick between debate variants if there were several, resolve
   * file conflicts against what earlier tasks staged, and commit the winner.
   */
  private async settle(
    task: Task,
    proposals: Proposal[],
    staging: StagingWorkspace,
    summary: RunSummary,
    options: OrchestratorOptions,
    settings: OrchestrationSettings,
    spend: (usd: number) => void
  ): Promise<Proposal | null> {
    let winner = proposals[0];

    if (proposals.length > 1) {
      // A debate is only worth a reviewer call because the whole point of
      // running N brains is comparing them on something better than confidence.
      const { reviews, cost } = await this.deps.consensus.review({
        proposals,
        staging,
        goal: options.goal,
        spentThisRun: summary.totalCostUsd,
        timeoutMs: settings.brainTimeoutMs,
        signal: options.signal,
      });
      spend(cost);
      summary.reviews.push(...reviews);

      const scored = this.deps.consensus.score(proposals, reviews, settings.consensusMode);
      const arbitrated = await this.deps.consensus.arbitrate({
        result: scored,
        reviews,
        staging,
        goal: options.goal,
        spentThisRun: summary.totalCostUsd,
        timeoutMs: settings.brainTimeoutMs,
        signal: options.signal,
      });
      spend(arbitrated.cost);

      winner = arbitrated.result.winner;
      summary.consensus.push(arbitrated.result);
      options.onEvent({ type: 'consensus', result: arbitrated.result });
    }

    if (!winner) {
      return null;
    }

    const { conflicts } = this.deps.conflicts.commit(staging, winner, task.id);
    for (const conflict of conflicts) {
      summary.conflicts.push(conflict);
      options.onEvent({ type: 'conflict', conflict });
      this.deps.bus.publish({
        type: conflict.resolution === 'unresolved' ? 'criticism' : 'status',
        from: 'orchestrator',
        taskId: task.id,
        subject: `Conflict on ${conflict.relPath} (${conflict.resolution})`,
        body: conflict.detail,
      });
    }
    return winner;
  }

  private debateSize(task: Task, settings: OrchestrationSettings): number {
    if (task.debate && task.debate > 1) {
      return task.debate;
    }
    return settings.debateMode ? Math.max(2, settings.debateSize) : 1;
  }

  private shouldAutoApply(settings: OrchestrationSettings, summary: RunSummary): boolean {
    if (settings.approvalPolicy === 'never') {
      return true;
    }
    if (settings.approvalPolicy === 'on-conflict') {
      // "Only stop me when it matters" still has to stop for a rejected change —
      // an unreviewed apply of something the reviewer rejected is the failure
      // this pipeline exists to prevent.
      const unresolved = summary.conflicts.some(c => c.resolution === 'unresolved');
      const rejected = summary.reviews.some(r => r.verdict === 'reject');
      return !unresolved && !rejected;
    }
    return false;
  }

  /**
   * Apply the reviewed change set. Separate from `run` on purpose: the user's
   * approval arrives from the UI, minutes later, on its own schedule.
   */
  public async apply(
    summary: RunSummary,
    options: Pick<OrchestratorOptions, 'onEvent' | 'signal'>,
    approve?: ChangeApprover
  ): Promise<RunSummary> {
    const executor = new Executor(approve);
    const outcome = await executor.apply(summary.changes, options.signal);

    summary.state = 'applied';
    options.onEvent({ type: 'applied', applied: outcome.applied.length, failed: outcome.failed.length + outcome.skipped.length });

    for (const { change, reason } of [...outcome.skipped, ...outcome.failed]) {
      options.onEvent({ type: 'log', text: `${change.relPath}: ${reason}` });
      this.deps.bus.publish({
        type: 'rejection',
        from: 'orchestrator',
        subject: `Not applied: ${change.relPath}`,
        body: reason,
      });
    }

    // What the team built is worth remembering across runs; what it failed to
    // apply is worth remembering more.
    this.deps.memory.remember(
      'workspace',
      'orchestrator',
      `Run "${summary.goal}": applied ${outcome.applied.length} file(s)` +
        (outcome.skipped.length ? `, skipped ${outcome.skipped.length}` : '') +
        (outcome.failed.length ? `, ${outcome.failed.length} failed` : '') +
        '.',
      summary.runId
    );

    this.deps.bus.publish({
      type: 'completion',
      from: 'orchestrator',
      subject: 'Run applied',
      body: `${outcome.applied.length} file(s) written.`,
    });
    return summary;
  }

  /** Discard a run's staged changes. Nothing was on disk, so this just forgets. */
  public discard(summary: RunSummary): void {
    summary.changes = [];
    summary.state = 'cancelled';
    this.staging = undefined;
    this.deps.bus.publish({
      type: 'rejection',
      from: 'user',
      subject: 'Run discarded',
      body: 'The user rejected the change set. Nothing was written.',
    });
  }

  /** For the UI: everything currently staged, without applying it. */
  public stagedChanges(): FileChange[] {
    return this.staging ? this.staging.changes() : [];
  }
}

/** Re-exported so consumers can type a summary without importing types.ts. */
export type { RunSummary, Conflict, ConsensusResult, ReviewScore };
