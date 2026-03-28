// Synapse Forge v0.4 — Task Decomposer
// ONE Claude CLI call. Input: requirements. Output: plan.json.
// No HTTP API — spawns CLI process.

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Requirements, Plan, ForgeConfig } from './types.js';
import { safeWriteJSON, withMeta } from './utils.js';
import { ContextProvider } from './context.js';

export class Decomposer {
  private config: ForgeConfig;
  private context: ContextProvider;

  constructor(config: ForgeConfig, context: ContextProvider) {
    this.config = config;
    this.context = context;
  }

  /**
   * Decompose requirements into a task plan.
   * Makes one CLI call, parses JSON output, writes plan.json.
   */
  async decompose(requirements: Requirements): Promise<Plan> {
    // Check for matching decomposition pattern
    const pattern = this.context.getDecompositionPattern(requirements);
    const projectCtx = this.context.getProjectContext();

    const prompt = this.buildPrompt(requirements, pattern, projectCtx);

    console.log('[Decomposer] Calling Claude CLI for task decomposition...');

    const { stdout, exitCode } = await this.spawnCLI(prompt);

    if (exitCode !== 0) {
      throw new Error(`Decomposer CLI exited with code ${exitCode}`);
    }

    // Parse plan from CLI output
    const plan = this.parsePlan(stdout, requirements.project);

    // Validate plan
    this.validatePlan(plan);

    // Write plan.json
    safeWriteJSON(
      path.join(this.config.synapse_dir, 'plan.json'),
      withMeta(plan, 'decomposer'),
    );

    console.log(`[Decomposer] Plan created: ${plan.tasks.length} tasks`);
    return plan;
  }

  private buildPrompt(requirements: Requirements, pattern: string | null, projectCtx: string | null): string {
    const parts: string[] = [
      `You are a task decomposer for a software delivery pipeline.`,
      `Given requirements, produce a structured execution plan.`,
      ``,
      `## Requirements`,
      `Project: ${requirements.project}`,
      `Description: ${requirements.description}`,
      `Tech stack: ${JSON.stringify(requirements.tech_stack)}`,
      `Acceptance criteria:`,
      ...requirements.acceptance_criteria.map(c => `- ${c}`),
      `Constraints:`,
      ...requirements.constraints.map(c => `- ${c}`),
      `Output directory: ${requirements.output_dir}`,
    ];

    if (projectCtx) {
      parts.push(``, `## Project Context`, projectCtx);
    }

    if (pattern) {
      parts.push(``, `## Example Decomposition Pattern`, pattern);
    }

    parts.push(
      ``,
      `## Output Format`,
      `Output ONLY valid JSON matching this structure:`,
      `{`,
      `  "project": "${requirements.project}",`,
      `  "phase": "mvp",`,
      `  "tasks": [`,
      `    {`,
      `      "id": "unique-task-id",`,
      `      "name": "Human-readable task name",`,
      `      "description": "What this task does",`,
      `      "prompt": "FULL detailed prompt for the code-writing agent. Include file paths, naming conventions, expected output. This is the actual instruction.",`,
      `      "test_criteria": ["criterion 1", "criterion 2"],`,
      `      "depends_on": ["other-task-id"],`,
      `      "requires_review": false,`,
      `      "parallel_group": "A"`,
      `    }`,
      `  ]`,
      `}`,
      ``,
      `Rules:`,
      `- Each task prompt must be self-contained and detailed enough for an AI agent to execute without clarification`,
      `- test_criteria should be verifiable (file existence, command exits 0, etc.)`,
      `- Use parallel_group to mark tasks that can run concurrently (same letter = same group)`,
      `- depends_on references task IDs that must complete first`,
      `- Order tasks by dependency: foundations first, then features`,
      `- 5-15 tasks is the sweet spot. Don't over-decompose.`,
    );

    return parts.join('\n');
  }

  private spawnCLI(prompt: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const { command, args, timeout_ms } = this.config.decomposer;

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
        reject(new Error(`Decomposer timed out after ${timeout_ms}ms`));
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

  /** Extract and parse JSON plan from CLI output. */
  private parsePlan(output: string, project: string): Plan {
    // Try to find JSON block in output
    const jsonMatch = output.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Decomposer output contains no valid JSON plan. Output:\n${output.slice(-2000)}`);
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        project: parsed.project || project,
        phase: parsed.phase || 'mvp',
        tasks: (parsed.tasks || []).map((t: any) => ({
          id: t.id,
          name: t.name,
          description: t.description || t.name,
          prompt: t.prompt,
          test_criteria: t.test_criteria || [],
          depends_on: t.depends_on || [],
          requires_review: t.requires_review || false,
          parallel_group: t.parallel_group,
          status: 'pending' as const,
        })),
      };
    } catch (e: any) {
      throw new Error(`Failed to parse decomposer JSON: ${e.message}`);
    }
  }

  /** Basic validation of the plan. */
  private validatePlan(plan: Plan): void {
    if (!plan.tasks || plan.tasks.length === 0) {
      throw new Error('Plan has no tasks');
    }

    const ids = new Set(plan.tasks.map(t => t.id));

    for (const task of plan.tasks) {
      if (!task.id) throw new Error('Task missing id');
      if (!task.prompt) throw new Error(`Task ${task.id} missing prompt`);

      for (const dep of task.depends_on) {
        if (!ids.has(dep)) {
          throw new Error(`Task ${task.id} depends on unknown task: ${dep}`);
        }
      }
    }
  }
}
