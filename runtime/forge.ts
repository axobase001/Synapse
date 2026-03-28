// Synapse Forge v0.4 — Main Orchestrator
// Runs the 5-phase unmanned delivery pipeline.

import fs from 'node:fs';
import path from 'node:path';
import type { Requirements, Plan, Task, HistoryEntry, ForgeConfig } from './types.js';
import { safeReadJSON, safeWriteJSON, withMeta, archiveFile } from './utils.js';
import { Decomposer } from './decomposer.js';
import { Generator } from './generator.js';
import { Validator } from './validator.js';
import { Router } from './router.js';
import { Reviewer } from './reviewer.js';
import { Notifier } from './notifier.js';
import { ContextProvider } from './context.js';

export class SynapseForge {
  private config: ForgeConfig;
  private decomposer: Decomposer;
  private generator: Generator;
  private validator: Validator;
  private router: Router;
  private reviewer: Reviewer;
  private notifier: Notifier;
  private context: ContextProvider;
  private history: HistoryEntry[] = [];

  constructor(config: ForgeConfig) {
    this.config = config;
    this.context = new ContextProvider(path.join(path.dirname(config.synapse_dir), 'context'));
    this.decomposer = new Decomposer(config, this.context);
    this.generator = new Generator(config);
    this.validator = new Validator(config);
    this.router = new Router();
    this.reviewer = new Reviewer(config);
    this.notifier = new Notifier(config);

    this.ensureDirs();
  }

  // ── Public API ──

  /**
   * Full pipeline: decompose → execute → review → notify.
   */
  async run(requirementsPath: string): Promise<void> {
    console.log('═══════════════════════════════════════════════');
    console.log('  Synapse Forge v0.4');
    console.log('═══════════════════════════════════════════════');

    // Phase 1: Read requirements (human produced this externally)
    const requirements = this.loadRequirements(requirementsPath);
    console.log(`[Forge] Project: ${requirements.project}`);
    console.log(`[Forge] Acceptance criteria: ${requirements.acceptance_criteria.length}`);

    // Phase 2: Decompose
    const plan = await this.decomposer.decompose(requirements);
    console.log(`[Forge] Plan: ${plan.tasks.length} tasks`);

    // Phase 3: Execute
    await this.executePlan(plan);

    // Phase 4: Review
    const review = await this.reviewer.review(requirements, plan, this.history);

    // Handle NEEDS_WORK: re-execute corrected tasks
    if (review.verdict === 'NEEDS_WORK' && review.corrections?.length) {
      console.log(`[Forge] Review: NEEDS_WORK — ${review.corrections.length} corrections`);
      await this.applyCorrections(plan, review);

      // Re-review
      const reReview = await this.reviewer.review(requirements, plan, this.history);
      await this.notifier.notify(reReview, this.config.project_dir);
    } else {
      // Phase 5: Notify
      await this.notifier.notify(review, this.config.project_dir);
    }

    this.printSummary();
  }

  /**
   * Plan only: decompose requirements, write plan.json, stop.
   */
  async plan(requirementsPath: string): Promise<Plan> {
    const requirements = this.loadRequirements(requirementsPath);
    return this.decomposer.decompose(requirements);
  }

  /**
   * Execute an existing plan (skip decomposition).
   */
  async execute(planPath: string): Promise<void> {
    const result = safeReadJSON<Plan>(planPath, ['project', 'tasks']);
    if (!result.ok) {
      throw new Error(`Cannot read plan: ${result.error}`);
    }
    await this.executePlan(result.data);
    this.printSummary();
  }

  /**
   * Resume from interruption using history.json.
   */
  async resume(): Promise<void> {
    const histResult = safeReadJSON<{ entries: HistoryEntry[] }>(
      path.join(this.config.synapse_dir, 'history.json'),
    );
    if (histResult.ok) {
      this.history = histResult.data.entries || [];
    }

    const planResult = safeReadJSON<Plan>(
      path.join(this.config.synapse_dir, 'plan.json'),
      ['project', 'tasks'],
    );
    if (!planResult.ok) {
      throw new Error('No plan.json found to resume from');
    }

    const plan = planResult.data;
    const completedIds = new Set(
      this.history.filter(h => h.final_status === 'completed').map(h => h.task_id),
    );

    // Mark completed tasks
    for (const task of plan.tasks) {
      if (completedIds.has(task.id)) {
        task.status = 'completed';
      }
    }

    const remaining = plan.tasks.filter(t => t.status !== 'completed').length;
    console.log(`[Forge] Resuming: ${remaining} tasks remaining`);

    await this.executePlan(plan);
    this.printSummary();
  }

  /**
   * Print current status.
   */
  status(): void {
    const planResult = safeReadJSON<Plan>(path.join(this.config.synapse_dir, 'plan.json'));
    const histResult = safeReadJSON<{ entries: HistoryEntry[] }>(path.join(this.config.synapse_dir, 'history.json'));

    if (!planResult.ok) {
      console.log('No active plan found.');
      return;
    }

    const plan = planResult.data;
    const entries = histResult.ok ? histResult.data.entries || [] : [];
    const completedIds = new Set(entries.filter(e => e.final_status === 'completed').map(e => e.task_id));
    const failedIds = new Set(entries.filter(e => e.final_status === 'failed').map(e => e.task_id));

    console.log(`Project: ${plan.project}`);
    console.log(`Tasks: ${plan.tasks.length}`);
    console.log('');

    for (const task of plan.tasks) {
      const icon = completedIds.has(task.id) ? '✓' : failedIds.has(task.id) ? '✗' : '○';
      const entry = entries.find(e => e.task_id === task.id);
      const attempts = entry ? ` (${entry.attempts} attempts)` : '';
      console.log(`  ${icon} ${task.id}: ${task.name}${attempts}`);
    }

    console.log('');
    console.log(`Completed: ${completedIds.size} / ${plan.tasks.length}`);
    console.log(`Failed: ${failedIds.size}`);
  }

  // ── Internal ──

  /**
   * Execute all tasks in a plan, respecting dependencies and parallelism.
   */
  private async executePlan(plan: Plan): Promise<void> {
    const completedIds = new Set(
      this.history.filter(h => h.final_status === 'completed').map(h => h.task_id),
    );

    // Group tasks by parallel_group
    const groups = this.buildExecutionGroups(plan.tasks, completedIds);

    for (const group of groups) {
      console.log(`\n[Forge] Executing group: ${group.map(t => t.id).join(', ')}`);

      // Run tasks in group concurrently (limited by semaphore)
      const semaphore = new Semaphore(this.config.max_parallel_tasks);

      await Promise.all(
        group.map(task => semaphore.run(() => this.executeTask(task))),
      );
    }
  }

  /**
   * Execute a single task through the generator → validator → router loop.
   */
  private async executeTask(task: Task): Promise<void> {
    if (task.status === 'completed') return;

    console.log(`\n  ┌─ Task: ${task.id} — ${task.name}`);
    task.status = 'in_progress';

    const maxAttempts = this.config.generator.max_attempts;
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`  │  Attempt ${attempt}/${maxAttempts}`);

      // 1. Generator writes code
      console.log(`  │  [Generator] Running...`);
      const result = await this.generator.execute(task, attempt, feedback);

      if (result.status === 'failure' && result.error) {
        console.log(`  │  [Generator] Error: ${result.error.slice(0, 200)}`);
      } else {
        console.log(`  │  [Generator] Done. ${result.files_changed.length} files changed.`);
      }

      // 2. Validator tests code
      console.log(`  │  [Validator] Running...`);
      const validation = await this.validator.validate(task, result);
      const passCount = validation.criteria_results.filter(c => c.passed).length;
      const total = validation.criteria_results.length;
      console.log(`  │  [Validator] ${passCount}/${total} criteria passed.`);

      // 3. Router decides
      const verdict = this.router.route(validation, attempt, maxAttempts);
      console.log(`  │  [Router] Verdict: ${verdict.verdict}`);

      if (verdict.verdict === 'PASS') {
        task.status = 'completed';
        this.recordHistory(task, attempt, 'completed', validation.criteria_results);
        if (feedback) this.context.saveFeedback(task, feedback);
        console.log(`  └─ PASS ✓`);
        return;
      }

      if (verdict.verdict === 'REVISE') {
        feedback = verdict.feedback;
        this.context.saveFeedback(task, feedback || '');
        console.log(`  │  Retrying with feedback...`);
        continue;
      }

      if (verdict.verdict === 'ABORT') {
        task.status = 'failed';
        this.recordHistory(task, attempt, 'failed', validation.criteria_results);
        console.log(`  └─ ABORT ✗ — ${verdict.reason?.slice(0, 200)}`);
        return;
      }
    }
  }

  /**
   * Build execution groups from tasks, respecting dependencies.
   * Returns array of groups, each group is an array of tasks that can run in parallel.
   */
  private buildExecutionGroups(tasks: Task[], completedIds: Set<string>): Task[][] {
    const remaining = tasks.filter(t => !completedIds.has(t.id));
    const groups: Task[][] = [];
    const scheduled = new Set(completedIds);

    while (remaining.length > 0) {
      // Find tasks whose dependencies are all satisfied
      const ready = remaining.filter(t =>
        t.depends_on.every(dep => scheduled.has(dep)),
      );

      if (ready.length === 0) {
        // Deadlock: remaining tasks have unresolvable dependencies
        console.warn(`[Forge] ${remaining.length} tasks have unresolvable dependencies, scheduling anyway`);
        groups.push([...remaining]);
        break;
      }

      groups.push(ready);
      for (const t of ready) {
        scheduled.add(t.id);
        const idx = remaining.indexOf(t);
        if (idx >= 0) remaining.splice(idx, 1);
      }
    }

    return groups;
  }

  /** Apply reviewer corrections by re-executing specific tasks. */
  private async applyCorrections(plan: Plan, review: import('./types.js').Review): Promise<void> {
    if (!review.corrections) return;

    for (const correction of review.corrections) {
      const task = plan.tasks.find(t => t.id === correction.task_id);
      if (!task) continue;

      console.log(`[Forge] Applying correction to ${task.id}: ${correction.issue}`);
      task.status = 'pending';
      task.prompt += `\n\n--- REVIEWER CORRECTION ---\n${correction.issue}\nSuggested fix: ${correction.suggested_fix}`;

      await this.executeTask(task);
    }
  }

  private recordHistory(task: Task, attempts: number, status: 'completed' | 'failed', criteria?: any[]): void {
    const entry: HistoryEntry = {
      id: `${task.id}_${Date.now()}`,
      task_id: task.id,
      task_name: task.name,
      completed_at: new Date().toISOString(),
      attempts,
      final_status: status,
      validation_results: criteria,
    };

    this.history.push(entry);
    this.saveHistory();
  }

  private saveHistory(): void {
    safeWriteJSON(
      path.join(this.config.synapse_dir, 'history.json'),
      withMeta({ entries: this.history }, 'forge'),
    );
  }

  private loadRequirements(reqPath: string): Requirements {
    const result = safeReadJSON<Requirements>(reqPath, ['project', 'description', 'acceptance_criteria']);
    if (!result.ok) {
      throw new Error(`Cannot load requirements from ${reqPath}: ${result.error}`);
    }
    return result.data;
  }

  private printSummary(): void {
    const completed = this.history.filter(h => h.final_status === 'completed').length;
    const failed = this.history.filter(h => h.final_status === 'failed').length;
    const totalAttempts = this.history.reduce((sum, h) => sum + h.attempts, 0);

    console.log('\n═══════════════════════════════════════════════');
    console.log(`  Forge Complete`);
    console.log(`  Tasks: ${completed} completed, ${failed} failed`);
    console.log(`  Total attempts: ${totalAttempts}`);
    console.log('═══════════════════════════════════════════════');
  }

  private ensureDirs(): void {
    const dirs = [
      this.config.synapse_dir,
      path.join(this.config.synapse_dir, 'archive'),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/** Simple counting semaphore for limiting concurrency. */
class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  private release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}
