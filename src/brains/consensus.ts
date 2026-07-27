import { BrainRegistry } from './registry';
import { BrainRunner, extractJson } from './runner';
import { StagingWorkspace } from './staging';
import { ConversationBus } from './bus';
import { ConsensusResult, OrchestrationSettings, Proposal, ReviewScore, Task } from './types';

/**
 * Review and consensus.
 *
 * Consensus here is explicitly NOT a vote. Three brains agreeing because they
 * inherited the same wrong assumption is not evidence, and the majority of a
 * sample of three is noise. Instead each proposal is scored on axes that mean
 * something independently — reviewer quality, security, architecture fit, the
 * brain's own weighted confidence, cost and latency — and the highest weighted
 * total wins. The Consensus brain then writes the rationale, so a human reading
 * the decision sees an argument rather than a number.
 */

/**
 * Weights. Correctness signals dominate; cost and latency are tie-breakers, not
 * drivers — the cheapest wrong answer is still wrong.
 */
const WEIGHTS = {
  quality: 0.25,
  security: 0.2,
  architecture: 0.15,
  confidence: 0.12,
  performance: 0.1,
  tests: 0.08,
  evidence: 0.05,
  cost: 0.03,
  latency: 0.02,
};

export interface ConsensusDeps {
  runner: BrainRunner;
  registry: BrainRegistry;
  bus: ConversationBus;
}

const REVIEW_INSTRUCTION = `
Score every proposal below. Include a "reviews" array in your JSON block:

"reviews": [
  {
    "key": "the proposal key exactly as given",
    "quality": 0.0,
    "security": 0.0,
    "performance": 0.0,
    "architecture": 0.0,
    "tests": 0.0,
    "verdict": "accept | revise | reject",
    "comment": "the one thing that would most improve this proposal"
  }
]

Every score is 0 to 1. Score each proposal on its own merits — do not grade on a
curve, and do not give everything 0.7 to avoid committing. A proposal you would
not want applied to this repository gets a low score and a reject verdict, and
you say concretely why.
`.trim();

const DECIDE_INSTRUCTION = `
Choose which of these competing proposals should ship. Include in your JSON block:

"winner": "the key of the proposal you choose",
"rationale": "the single decisive reason, then what the runner-up did better"

Judge on merit for this codebase. Do not count votes, and do not favour the
proposal that sounds most certain. If none of them is safe to apply, set winner
to "none" and say what is missing.
`.trim();

export class ConsensusEngine {
  constructor(private readonly deps: ConsensusDeps) {}

  /** Run the Reviewer brain over a set of proposals. Empty on any failure. */
  public async review(options: {
    proposals: Proposal[];
    staging: StagingWorkspace;
    goal: string;
    spentThisRun: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ reviews: ReviewScore[]; cost: number }> {
    const reviewer = this.deps.registry.byRole('reviewer');
    if (!reviewer || options.proposals.length === 0) {
      return { reviews: [], cost: 0 };
    }

    const task: Task = {
      id: 'review',
      title: 'Review the team output',
      brainId: reviewer.id,
      dependsOn: [],
      instruction: `${REVIEW_INSTRUCTION}\n\nPROPOSALS:\n\n${renderProposals(options.proposals)}`,
    };

    const proposal = await this.deps.runner.run({
      task,
      brain: reviewer,
      staging: options.staging,
      goal: options.goal,
      spentThisRun: options.spentThisRun,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    const reviews = parseReviews(proposal.raw, new Set(options.proposals.map(p => p.key)));
    for (const review of reviews) {
      this.deps.bus.publish({
        type: 'review',
        from: reviewer.id,
        subject: `${review.verdict}: ${review.proposalKey}`,
        body: review.comment,
        data: { ...review },
      });
    }
    return { reviews, cost: proposal.costUsd };
  }

  /**
   * Pick a winner from proposals for the SAME task. Pure scoring — no model call
   * — so it is deterministic, testable, and free.
   */
  public score(
    proposals: Proposal[],
    reviews: ReviewScore[],
    mode: OrchestrationSettings['consensusMode'] = 'weighted'
  ): ConsensusResult {
    const byKey = new Map(reviews.map(r => [r.proposalKey, r]));

    if (mode === 'first' || proposals.length === 1) {
      return {
        winner: proposals[0],
        runnersUp: proposals.slice(1),
        scores: proposals.map(p => ({ key: p.key, total: p.confidence, parts: { confidence: p.confidence } })),
        rationale: proposals.length === 1 ? 'Only one proposal.' : 'First-past-the-post mode is enabled in settings.',
      };
    }

    // Cost and latency are only meaningful relative to the other options here,
    // so they are normalised against the best in the set rather than absolutely.
    const minCost = Math.min(...proposals.map(p => p.costUsd));
    const maxCost = Math.max(...proposals.map(p => p.costUsd));
    const minLatency = Math.min(...proposals.map(p => p.latencyMs));
    const maxLatency = Math.max(...proposals.map(p => p.latencyMs));

    const scores = proposals.map(p => {
      const review = byKey.get(p.key);
      const parts: Record<string, number> = {
        // An unreviewed proposal is not assumed good OR bad: 0.5 keeps it in
        // contention while letting a reviewed, well-scored rival beat it.
        quality: review?.quality ?? 0.5,
        security: review?.security ?? 0.5,
        architecture: review?.architecture ?? 0.5,
        performance: review?.performance ?? 0.5,
        tests: review?.tests ?? 0.5,
        confidence: p.confidence,
        // Claims backed by something a tool actually returned.
        evidence: Math.min(1, p.evidence.length / 4),
        cost: normaliseInverse(p.costUsd, minCost, maxCost),
        latency: normaliseInverse(p.latencyMs, minLatency, maxLatency),
      };

      let total = 0;
      for (const [axis, weight] of Object.entries(WEIGHTS)) {
        total += (parts[axis] ?? 0.5) * weight;
      }
      // A reject is disqualifying, not a small deduction. The reviewer is the
      // last gate before a human, and a rejected change winning on cost is
      // exactly the failure this whole pipeline exists to prevent.
      if (review?.verdict === 'reject') {
        total *= 0.25;
        parts.rejected = 1;
      } else if (review?.verdict === 'revise') {
        total *= 0.75;
      }
      if (mode === 'reviewer' && review) {
        total = (parts.quality + parts.security + parts.architecture) / 3;
      }
      return { key: p.key, total, parts };
    });

    const ranked = [...scores].sort((a, b) => b.total - a.total);
    const winner = proposals.find(p => p.key === ranked[0].key) || proposals[0];
    const runnersUp = proposals.filter(p => p.key !== winner.key);

    return {
      winner,
      runnersUp,
      scores: ranked,
      rationale: explain(winner, ranked, byKey.get(winner.key)),
    };
  }

  /**
   * Ask the Consensus brain to arbitrate. Only worth a model call when the
   * scores are genuinely close — a clear winner needs an explanation, not a
   * second opinion, and `score()` already produced one.
   */
  public async arbitrate(options: {
    result: ConsensusResult;
    reviews: ReviewScore[];
    staging: StagingWorkspace;
    goal: string;
    spentThisRun: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ result: ConsensusResult; cost: number }> {
    const brain = this.deps.registry.byRole('consensus');
    const { result } = options;
    const all = [result.winner, ...result.runnersUp];
    if (!brain || all.length < 2) {
      return { result, cost: 0 };
    }

    const top = result.scores[0]?.total ?? 0;
    const second = result.scores[1]?.total ?? 0;
    if (top - second > 0.08) {
      return { result, cost: 0 }; // decisive on the numbers
    }

    const task: Task = {
      id: 'consensus',
      title: 'Decide between competing proposals',
      brainId: brain.id,
      dependsOn: [],
      instruction:
        `${DECIDE_INSTRUCTION}\n\nPROPOSALS:\n\n${renderProposals(all)}\n\n` +
        `REVIEWER SCORES:\n${options.reviews.map(r => `- ${r.proposalKey}: ${r.verdict} (quality ${r.quality}, security ${r.security}) — ${r.comment}`).join('\n') || '(none)'}\n\n` +
        `WEIGHTED SCORES (informational, not binding):\n${result.scores.map(s => `- ${s.key}: ${s.total.toFixed(3)}`).join('\n')}`,
    };

    const decision = await this.deps.runner.run({
      task,
      brain,
      staging: options.staging,
      goal: options.goal,
      spentThisRun: options.spentThisRun,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    const parsed = parseDecision(decision.raw);
    if (!parsed.winner || parsed.winner === 'none') {
      return {
        result: { ...result, rationale: parsed.rationale || result.rationale },
        cost: decision.costUsd,
      };
    }
    const chosen = all.find(p => p.key === parsed.winner);
    if (!chosen) {
      return { result: { ...result, rationale: parsed.rationale || result.rationale }, cost: decision.costUsd };
    }

    this.deps.bus.publish({
      type: 'approval',
      from: brain.id,
      subject: `Chose ${chosen.brainId}'s approach`,
      body: parsed.rationale,
    });

    return {
      result: {
        winner: chosen,
        runnersUp: all.filter(p => p.key !== chosen.key),
        scores: result.scores,
        rationale: parsed.rationale || result.rationale,
      },
      cost: decision.costUsd,
    };
  }
}

/** 1 for the cheapest/fastest, 0 for the most expensive/slowest. */
function normaliseInverse(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) {
    return 1;
  }
  return 1 - (value - min) / (max - min);
}

function explain(winner: Proposal, ranked: Array<{ key: string; total: number; parts: Record<string, number> }>, review?: ReviewScore): string {
  const top = ranked[0];
  const second = ranked[1];
  const margin = second ? top.total - second.total : 1;

  // Name the axis that actually decided it, not the highest absolute score.
  let decisive = 'overall balance';
  if (second) {
    let best = 0;
    for (const axis of Object.keys(WEIGHTS)) {
      const delta = ((top.parts[axis] ?? 0.5) - (second.parts[axis] ?? 0.5)) * (WEIGHTS as any)[axis];
      if (delta > best) {
        best = delta;
        decisive = axis;
      }
    }
  }

  const parts = [
    `${winner.brainId} (${winner.model}) scored ${top.total.toFixed(2)}`,
    second ? `ahead of the next by ${margin.toFixed(2)}, decided mainly on ${decisive}` : 'unopposed',
  ];
  if (review) {
    parts.push(`Reviewer: ${review.verdict} — ${review.comment}`);
  }
  if (margin < 0.05 && second) {
    parts.push('The margin is thin, so the runner-up is worth a look before you approve.');
  }
  return parts.join('. ') + '.';
}

function renderProposals(proposals: Proposal[]): string {
  return proposals
    .map(p =>
      [
        `### ${p.key}`,
        `Brain: ${p.brainId} | Model: ${p.model} | Self-reported confidence: ${p.confidence.toFixed(2)}`,
        `Files changed: ${p.changes.map(c => c.relPath).join(', ') || '(none)'}`,
        `Summary: ${p.summary}`,
        p.reasoning ? `Reasoning: ${p.reasoning}` : '',
        p.pros.length ? `Pros: ${p.pros.join('; ')}` : '',
        p.cons.length ? `Cons: ${p.cons.join('; ')}` : '',
        p.risks.length ? `Risks: ${p.risks.join('; ')}` : '',
        p.evidence.length ? `Evidence: ${p.evidence.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}

export function parseReviews(raw: string, validKeys: Set<string>): ReviewScore[] {
  const obj = safeParse(raw);
  if (!obj || !Array.isArray(obj.reviews)) {
    return [];
  }
  const out: ReviewScore[] = [];
  for (const r of obj.reviews) {
    const key = typeof r?.key === 'string' ? r.key.trim() : '';
    if (!validKeys.has(key)) {
      continue; // a score for a proposal that does not exist is noise
    }
    out.push({
      proposalKey: key,
      quality: unit(r.quality),
      security: unit(r.security),
      performance: unit(r.performance),
      architecture: unit(r.architecture),
      tests: unit(r.tests),
      verdict: ['accept', 'revise', 'reject'].includes(r.verdict) ? r.verdict : 'revise',
      comment: typeof r.comment === 'string' ? r.comment.trim() : '',
    });
  }
  return out;
}

export function parseDecision(raw: string): { winner: string; rationale: string } {
  const obj = safeParse(raw);
  return {
    winner: typeof obj?.winner === 'string' ? obj.winner.trim() : '',
    rationale: typeof obj?.rationale === 'string' ? obj.rationale.trim() : '',
  };
}

function safeParse(raw: string): any {
  const json = extractJson(raw || '');
  if (!json) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(json.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function unit(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) {
    return 0.5;
  }
  // Models emit 0–10 and 0–100 as readily as 0–1 despite the instruction.
  const scaled = n > 1 ? (n > 10 ? n / 100 : n / 10) : n;
  return Math.min(1, Math.max(0, scaled));
}
