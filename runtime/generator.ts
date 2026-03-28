// Synapse Forge v0.4 — Generator (Claude CLI wrapper)
// Spawns Claude CLI to write code. Does NOT evaluate its own output.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Task, TaskResult, ForgeConfig } from './types.js';
import { safeWriteJSON, withMeta } from './utils.js';

export class Generator {
  private config: ForgeConfig;
  private synapseDir: string;

  constructor(config: ForgeConfig) {
    this.config = config;
    this.synapseDir = config.synapse_dir;
  }

  /**
   * Execute a task: spawn CLI, feed it the prompt, collect output.
   * On retry, append validator feedback to the prompt.
   */
  async execute(task: Task, attempt: number, feedback?: string): Promise<TaskResult> {
    const startTime = new Date().toISOString();

    // Build the prompt
    let fullPrompt = task.prompt;
    if (feedback && attempt > 1) {
      fullPrompt += `\n\n--- PREVIOUS ATTEMPT FAILED ---\n`;
      fullPrompt += `Attempt ${attempt - 1} feedback:\n${feedback}\n`;
      fullPrompt += `Fix the issues above and try again.\n`;
    }

    // Write heartbeat
    this.writeHeartbeat(task.id, 'generating');

    try {
      const { stdout, stderr, exitCode } = await this.spawnCLI(fullPrompt, task);

      // Collect changed files via git
      const filesChanged = this.getChangedFiles();

      const result: TaskResult = {
        task_id: task.id,
        attempt,
        timestamp: startTime,
        status: exitCode === 0 ? 'success' : 'failure',
        files_changed: filesChanged,
        diff_summary: this.getDiffSummary(),
        stdout: stdout.slice(-5000), // Keep last 5k chars
        error: exitCode !== 0 ? `CLI exited with code ${exitCode}. stderr: ${stderr.slice(-2000)}` : undefined,
      };

      // Persist result
      safeWriteJSON(
        path.join(this.synapseDir, 'result.json'),
        withMeta(result, 'generator', task.id, attempt),
      );

      return result;
    } catch (err: any) {
      const result: TaskResult = {
        task_id: task.id,
        attempt,
        timestamp: startTime,
        status: 'failure',
        files_changed: [],
        diff_summary: '',
        stdout: '',
        error: `Generator crashed: ${err.message}`,
      };

      safeWriteJSON(
        path.join(this.synapseDir, 'result.json'),
        withMeta(result, 'generator', task.id, attempt),
      );

      return result;
    }
  }

  /**
   * Spawn the CLI process and collect output.
   */
  private spawnCLI(
    prompt: string,
    task: Task,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const { command, args, timeout_ms } = this.config.generator;

      const systemPrompt = `You are working on project: ${this.config.project_dir}. Task: ${task.name}. ${task.description}`;

      const fullArgs = [
        ...args,
        '--system-prompt', systemPrompt,
        '-p', prompt,
      ];

      const proc = spawn(command, fullArgs, {
        cwd: this.config.project_dir,
        shell: true,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        this.writeHeartbeat(task.id, 'generating');
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Timeout guard
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
        reject(new Error(`Generator timed out after ${timeout_ms}ms`));
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

  /** Get files changed since last commit (or all untracked). */
  private getChangedFiles(): string[] {
    try {
      const diff = execSync('git diff --name-only HEAD 2>/dev/null || git ls-files --others --exclude-standard', {
        cwd: this.config.project_dir,
        encoding: 'utf-8',
      });
      return diff.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Get a brief diff summary. */
  private getDiffSummary(): string {
    try {
      return execSync('git diff --stat HEAD 2>/dev/null', {
        cwd: this.config.project_dir,
        encoding: 'utf-8',
      }).trim().slice(-2000);
    } catch {
      return '';
    }
  }

  /** Write heartbeat file for monitoring. */
  private writeHeartbeat(taskId: string, status: string): void {
    try {
      safeWriteJSON(path.join(this.synapseDir, 'heartbeat.json'), {
        timestamp: new Date().toISOString(),
        task_id: taskId,
        status,
        component: 'generator',
      });
    } catch {}
  }
}
