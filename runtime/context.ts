// Synapse Forge v0.4 — RAG-Lite Context Provider
// File-based pattern matching. No vector DB. Just structured lookup.

import fs from 'node:fs';
import path from 'node:path';
import type { Requirements, Task } from './types.js';

export class ContextProvider {
  private contextDir: string;
  private patternsDir: string;
  private feedbackDir: string;

  constructor(contextDir: string = './context') {
    this.contextDir = contextDir;
    this.patternsDir = path.join(contextDir, 'patterns');
    this.feedbackDir = path.join(contextDir, 'feedback-history');
    this.ensureDirs();
  }

  /**
   * Find a decomposition pattern that matches the requirements.
   * Simple keyword matching against pattern filenames and content.
   */
  getDecompositionPattern(requirements: Requirements): string | null {
    if (!fs.existsSync(this.patternsDir)) return null;

    const files = fs.readdirSync(this.patternsDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return null;

    const desc = `${requirements.description} ${Object.values(requirements.tech_stack).join(' ')}`.toLowerCase();

    // Score each pattern by keyword overlap
    let bestFile: string | null = null;
    let bestScore = 0;

    for (const file of files) {
      const name = file.replace('.md', '').replace(/-/g, ' ').toLowerCase();
      const keywords = name.split(/\s+/);
      const score = keywords.filter(kw => desc.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestFile = file;
      }
    }

    if (bestFile && bestScore > 0) {
      try {
        return fs.readFileSync(path.join(this.patternsDir, bestFile), 'utf-8');
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Find past feedback relevant to a task description.
   * Scans feedback-history/ for similar task descriptions.
   */
  getRelevantFeedback(taskDescription: string): string[] {
    if (!fs.existsSync(this.feedbackDir)) return [];

    const results: string[] = [];
    const keywords = taskDescription.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    try {
      const files = fs.readdirSync(this.feedbackDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.feedbackDir, file), 'utf-8');
          const entry = JSON.parse(raw);
          const content = `${entry.task_description || ''} ${entry.feedback || ''}`.toLowerCase();
          const matches = keywords.filter(kw => content.includes(kw)).length;

          if (matches >= 2) {
            results.push(entry.feedback);
          }
        } catch {}
      }
    } catch {}

    return results.slice(0, 5); // Cap at 5 relevant entries
  }

  /**
   * Save feedback from a failed attempt for future reference.
   */
  saveFeedback(task: Task, feedback: string): void {
    this.ensureDirs();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${task.id}_${timestamp}.json`;

    const entry = {
      task_id: task.id,
      task_description: task.description,
      feedback,
      saved_at: new Date().toISOString(),
    };

    try {
      fs.writeFileSync(
        path.join(this.feedbackDir, filename),
        JSON.stringify(entry, null, 2),
        'utf-8',
      );
    } catch {}
  }

  /**
   * Get project description if available.
   */
  getProjectContext(): string | null {
    const projectFile = path.join(this.contextDir, 'project.md');
    if (fs.existsSync(projectFile)) {
      try {
        return fs.readFileSync(projectFile, 'utf-8');
      } catch {}
    }
    return null;
  }

  private ensureDirs(): void {
    for (const dir of [this.contextDir, this.patternsDir, this.feedbackDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }
}
