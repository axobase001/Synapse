// Synapse Forge v0.4 — Validator (Codex wrapper)
// Spawns Codex (or falls back to shell) to test Generator's output.
// Does NOT write code. Only tests and critiques.

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import type { Task, TaskResult, ValidationResult, ForgeConfig, CriterionResult } from './types.js';
import { safeWriteJSON, withMeta } from './utils.js';

export class Validator {
  private config: ForgeConfig;
  private synapseDir: string;
  private codexAvailable: boolean | null = null;

  constructor(config: ForgeConfig) {
    this.config = config;
    this.synapseDir = config.synapse_dir;
  }

  /**
   * Validate a task result against its test criteria.
   * Uses Codex if available, falls back to running criteria as shell commands.
   */
  async validate(task: Task, result: TaskResult): Promise<ValidationResult> {
    this.writeHeartbeat(task.id, 'validating');

    // Check if Codex is available (cache result)
    if (this.codexAvailable === null) {
      this.codexAvailable = this.checkCodexAvailable();
    }

    if (this.codexAvailable) {
      return this.validateWithCodex(task, result);
    } else {
      return this.validateWithShell(task, result);
    }
  }

  /**
   * Full Codex validation: spawn Codex to analyze code and run tests.
   */
  private async validateWithCodex(task: Task, result: TaskResult): Promise<ValidationResult> {
    const criteriaList = task.test_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

    const prompt = [
      `Validate the following code changes for task: "${task.name}"`,
      ``,
      `Task description: ${task.description}`,
      ``,
      `Changed files: ${result.files_changed.join(', ') || 'none detected'}`,
      ``,
      `Test criteria (check ALL of these):`,
      criteriaList,
      ``,
      `For each criterion, run the necessary checks and report pass/fail.`,
      `If any fail, provide specific feedback on what's wrong and how to fix it.`,
      ``,
      `Output your results as JSON:`,
      `{"passed": boolean, "criteria_results": [{"criterion": "...", "passed": boolean, "detail": "..."}], "feedback": "..."}`,
    ].join('\n');

    try {
      const { stdout, exitCode } = await this.spawnValidator(prompt);

      // Try to parse structured output from Codex
      const parsed = this.parseValidatorOutput(stdout, task);

      const validation: ValidationResult = {
        task_id: task.id,
        passed: parsed.passed,
        criteria_results: parsed.criteria_results,
        feedback: parsed.feedback,
        raw_output: stdout.slice(-5000),
      };

      safeWriteJSON(
        path.join(this.synapseDir, 'feedback.json'),
        withMeta(validation, 'validator', task.id),
      );

      return validation;
    } catch (err: any) {
      // Codex crashed — fall back to shell
      console.warn(`Codex validation failed (${err.message}), falling back to shell`);
      this.codexAvailable = false;
      return this.validateWithShell(task, result);
    }
  }

  /**
   * Degraded mode: run test_criteria as shell commands directly.
   */
  private async validateWithShell(task: Task, result: TaskResult): Promise<ValidationResult> {
    const criteriaResults: CriterionResult[] = [];

    for (const criterion of task.test_criteria) {
      // Try to extract a runnable command from the criterion
      const command = this.extractCommand(criterion);

      if (command) {
        try {
          execSync(command, {
            cwd: this.config.project_dir,
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          criteriaResults.push({ criterion, passed: true });
        } catch (err: any) {
          criteriaResults.push({
            criterion,
            passed: false,
            detail: err.stderr?.slice(-500) || err.message,
          });
        }
      } else {
        // Can't extract a command — check if it's a file existence check
        const fileCheck = this.extractFileCheck(criterion);
        if (fileCheck) {
          const exists = this.checkFileExists(fileCheck);
          criteriaResults.push({
            criterion,
            passed: exists,
            detail: exists ? undefined : `File/directory not found: ${fileCheck}`,
          });
        } else {
          // Can't validate this criterion automatically
          criteriaResults.push({
            criterion,
            passed: false,
            detail: 'Cannot validate automatically (no runnable command detected)',
          });
        }
      }
    }

    const allPassed = criteriaResults.every(c => c.passed);
    const failedCriteria = criteriaResults.filter(c => !c.passed);
    const feedback = failedCriteria.length > 0
      ? failedCriteria.map(c => `- ${c.criterion}: ${c.detail || 'failed'}`).join('\n')
      : '';

    const validation: ValidationResult = {
      task_id: task.id,
      passed: allPassed,
      criteria_results: criteriaResults,
      feedback,
      raw_output: '[shell-based validation]',
    };

    safeWriteJSON(
      path.join(this.synapseDir, 'feedback.json'),
      withMeta(validation, 'validator', task.id),
    );

    return validation;
  }

  /** Spawn the validator CLI process. */
  private spawnValidator(prompt: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const { command, args, timeout_ms } = this.config.validator;

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
        reject(new Error(`Validator timed out after ${timeout_ms}ms`));
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

  /** Try to parse structured JSON from validator output. */
  private parseValidatorOutput(
    output: string,
    task: Task,
  ): { passed: boolean; criteria_results: CriterionResult[]; feedback: string } {
    // Look for JSON in the output
    const jsonMatch = output.match(/\{[\s\S]*"passed"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          passed: !!parsed.passed,
          criteria_results: Array.isArray(parsed.criteria_results) ? parsed.criteria_results : [],
          feedback: parsed.feedback || '',
        };
      } catch {}
    }

    // Fallback: treat non-zero exit as failure
    return {
      passed: false,
      criteria_results: task.test_criteria.map(c => ({
        criterion: c,
        passed: false,
        detail: 'Could not parse validator output',
      })),
      feedback: `Validator output could not be parsed. Raw output:\n${output.slice(-2000)}`,
    };
  }

  /** Extract a shell command from a criterion string (e.g., "python -c '...'" or backtick-quoted). */
  private extractCommand(criterion: string): string | null {
    // Match patterns like: `command here` or "exits 0" patterns
    const backtickMatch = criterion.match(/`([^`]+)`/);
    if (backtickMatch) return backtickMatch[1];

    // Match "run X" or "execute X" patterns
    const runMatch = criterion.match(/(?:run|execute)\s+(.+)/i);
    if (runMatch) return runMatch[1];

    // If criterion looks like a command (starts with known command names)
    const cmdPrefixes = ['python', 'node', 'npm', 'npx', 'pytest', 'jest', 'cargo', 'go ', 'make'];
    const lower = criterion.toLowerCase().trim();
    if (cmdPrefixes.some(p => lower.startsWith(p))) return criterion.trim();

    return null;
  }

  /** Extract a file path check from a criterion string. */
  private extractFileCheck(criterion: string): string | null {
    // "File X exists" or "X exist" patterns
    const match = criterion.match(/(?:files?\s+)?(?:exists?\s+(?:in\s+)?)?([./\w-]+(?:\/[./\w-]+)+)/i);
    if (match) return match[1];
    return null;
  }

  /** Check if a file or directory exists. */
  private checkFileExists(filePath: string): boolean {
    try {
      const full = path.resolve(this.config.project_dir, filePath);
      const { statSync } = require('node:fs');
      statSync(full);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if Codex CLI is installed. */
  private checkCodexAvailable(): boolean {
    try {
      execSync(`${this.config.validator.command} --version`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      console.log(`[Validator] ${this.config.validator.command} not found, using shell fallback`);
      return false;
    }
  }

  /** Write heartbeat. */
  private writeHeartbeat(taskId: string, status: string): void {
    try {
      safeWriteJSON(path.join(this.synapseDir, 'heartbeat.json'), {
        timestamp: new Date().toISOString(),
        task_id: taskId,
        status,
        component: 'validator',
      });
    } catch {}
  }
}
