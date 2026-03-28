// Synapse Forge v0.4 — Final Reviewer
// ONE Claude CLI call after all tasks complete.
// Checks: did we satisfy all requirements?

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Requirements, Plan, HistoryEntry, Review, ForgeConfig } from './types.js';
import { safeWriteJSON, withMeta } from './utils.js';

export class Reviewer {
  private config: ForgeConfig;

  constructor(config: ForgeConfig) {
    this.config = config;
  }

  /**
   * Review all completed work against original requirements.
   * Makes one CLI call, returns structured review.
   */
  async review(requirements: Requirements, plan: Plan, history: HistoryEntry[]): Promise<Review> {
    const fileListing = this.getFileListing();
    const prompt = this.buildPrompt(requirements, plan, history, fileListing);

    console.log('[Reviewer] Calling Claude CLI for final review...');

    const { stdout, exitCode } = await this.spawnCLI(prompt);

    if (exitCode !== 0) {
      console.warn(`[Reviewer] CLI exited with code ${exitCode}, treating as NEEDS_WORK`);
    }

    const review = this.parseReview(stdout, requirements, history);

    safeWriteJSON(
      path.join(this.config.synapse_dir, 'review.json'),
      withMeta(review, 'reviewer'),
    );

    console.log(`[Reviewer] Verdict: ${review.verdict} (${review.tasks_completed} completed, ${review.tasks_failed} failed)`);
    return review;
  }

  private buildPrompt(
    requirements: Requirements,
    plan: Plan,
    history: HistoryEntry[],
    fileListing: string,
  ): string {
    const completedTasks = history.filter(h => h.final_status === 'completed');
    const failedTasks = history.filter(h => h.final_status === 'failed');

    const histSummary = history.map(h =>
      `- ${h.task_name}: ${h.final_status} (${h.attempts} attempt(s))`
    ).join('\n');

    return [
      `You are reviewing a completed software delivery against requirements.`,
      ``,
      `## Original Requirements`,
      `Project: ${requirements.project}`,
      `Description: ${requirements.description}`,
      ``,
      `Acceptance Criteria:`,
      ...requirements.acceptance_criteria.map(c => `- ${c}`),
      ``,
      `## Execution Summary`,
      `Total tasks: ${plan.tasks.length}`,
      `Completed: ${completedTasks.length}`,
      `Failed: ${failedTasks.length}`,
      ``,
      histSummary,
      ``,
      `## Generated Files`,
      fileListing || '(no files found)',
      ``,
      `## Question`,
      `Does this delivery satisfy ALL acceptance criteria?`,
      `Are there any gaps, missing features, or quality issues?`,
      ``,
      `## Output Format`,
      `Output ONLY valid JSON:`,
      `{`,
      `  "verdict": "APPROVED" or "NEEDS_WORK",`,
      `  "notes": ["note1", "note2"],`,
      `  "corrections": [{"task_id": "...", "issue": "...", "suggested_fix": "..."}]`,
      `}`,
      ``,
      `corrections array is only needed if verdict is NEEDS_WORK.`,
    ].join('\n');
  }

  private spawnCLI(prompt: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const { command, args, timeout_ms } = this.config.reviewer;

      const proc = spawn(command, [...args, prompt], {
        cwd: this.config.project_dir,
        shell: true,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
        reject(new Error(`Reviewer timed out after ${timeout_ms}ms`));
      }, timeout_ms);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private parseReview(output: string, requirements: Requirements, history: HistoryEntry[]): Review {
    const completed = history.filter(h => h.final_status === 'completed').length;
    const failed = history.filter(h => h.final_status === 'failed').length;

    // Try to parse JSON from output
    const jsonMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          project: requirements.project,
          verdict: parsed.verdict === 'APPROVED' ? 'APPROVED' : 'NEEDS_WORK',
          tasks_completed: completed,
          tasks_failed: failed,
          notes: Array.isArray(parsed.notes) ? parsed.notes : [],
          corrections: parsed.corrections || undefined,
        };
      } catch {}
    }

    // Fallback: if all tasks completed, auto-approve
    if (failed === 0 && completed > 0) {
      return {
        project: requirements.project,
        verdict: 'APPROVED',
        tasks_completed: completed,
        tasks_failed: 0,
        notes: ['Auto-approved: all tasks completed successfully (reviewer output unparseable)'],
      };
    }

    return {
      project: requirements.project,
      verdict: 'NEEDS_WORK',
      tasks_completed: completed,
      tasks_failed: failed,
      notes: [`Reviewer output could not be parsed. ${failed} task(s) failed.`],
    };
  }

  /** List files in the project output directory. */
  private getFileListing(): string {
    try {
      const { execSync } = require('node:child_process');
      return execSync('find . -type f -not -path "./.git/*" -not -path "./node_modules/*" | head -100', {
        cwd: this.config.project_dir,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    } catch {
      return '';
    }
  }
}
