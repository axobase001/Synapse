// Synapse Forge v0.4 — Type definitions
// Extends v0.3 types for the unmanned execution pipeline.

// ── Task & Plan ──

export interface Task {
  id: string;
  name: string;
  description: string;
  prompt: string;
  test_criteria: string[];
  depends_on: string[];
  requires_review: boolean;
  parallel_group?: string;
  status: TaskStatus;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface Plan {
  project: string;
  phase: string;
  tasks: Task[];
}

// ── Requirements (Phase 1 output) ──

export interface Requirements {
  project: string;
  description: string;
  tech_stack: Record<string, string>;
  acceptance_criteria: string[];
  constraints: string[];
  output_dir: string;
}

// ── Generator output ──

export interface TaskResult {
  task_id: string;
  attempt: number;
  timestamp: string;
  status: 'success' | 'partial' | 'failure';
  files_changed: string[];
  diff_summary: string;
  stdout: string;
  error?: string;
}

// ── Validator output ──

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  detail?: string;
}

export interface ValidationResult {
  task_id: string;
  passed: boolean;
  criteria_results: CriterionResult[];
  feedback: string;
  raw_output: string;
}

// ── Router output ──

export type VerdictType = 'PASS' | 'REVISE' | 'ABORT';

export interface Verdict {
  verdict: VerdictType;
  feedback?: string;
  reason?: string;
}

// ── Reviewer output ──

export type ReviewVerdict = 'APPROVED' | 'NEEDS_WORK';

export interface Review {
  project: string;
  verdict: ReviewVerdict;
  tasks_completed: number;
  tasks_failed: number;
  notes: string[];
  corrections?: ReviewCorrection[];
}

export interface ReviewCorrection {
  task_id: string;
  issue: string;
  suggested_fix: string;
}

// ── History ──

export interface HistoryEntry {
  id: string;
  task_id: string;
  task_name: string;
  completed_at: string;
  attempts: number;
  final_status: 'completed' | 'failed' | 'skipped';
  validation_results?: CriterionResult[];
}

// ── Notification ──

export interface Notification {
  status: ReviewVerdict;
  project: string;
  completed_at: string;
  tasks_completed: number;
  tasks_failed: number;
  output_path: string;
  notes: string[];
}

// ── Config ──

/** All LLM calls go through CLI spawn. No HTTP API. */
export interface CLIConfig {
  command: string;
  args: string[];
  timeout_ms: number;
}

export interface ForgeConfig {
  generator: CLIConfig & { max_attempts: number };
  validator: CLIConfig;
  decomposer: CLIConfig;
  reviewer: CLIConfig;
  notification: {
    type: 'webhook' | 'email' | 'file';
    url?: string;
    fallback?: string;
  };
  max_parallel_tasks: number;
  project_dir: string;
  synapse_dir: string;
}

// ── Heartbeat (reused from v0.3) ──

export interface Heartbeat {
  timestamp: string;
  task_id: string;
  status: string;
}
