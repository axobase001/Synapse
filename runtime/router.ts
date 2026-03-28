// Synapse Forge v0.4 — Rule-Based Pass/Fail Router
// NO LLM. Pure logic. This is a traffic light, not a brain.

import type { ValidationResult, Verdict } from './types.js';

export class Router {
  /**
   * Decide what to do with a validation result.
   *
   * Rule 1: All criteria passed → PASS
   * Rule 2: Under max attempts → REVISE with feedback
   * Rule 3: Max attempts exceeded → ABORT
   */
  route(validation: ValidationResult, attempt: number, maxAttempts: number): Verdict {
    if (maxAttempts < 1) {
      throw new Error('maxAttempts must be >= 1');
    }
    if (attempt < 1) {
      throw new Error('attempt must be >= 1');
    }

    // Rule 1: All passed
    if (validation.passed) {
      return { verdict: 'PASS' };
    }

    // Rule 2: Still have retries left
    if (attempt < maxAttempts) {
      return {
        verdict: 'REVISE',
        feedback: validation.feedback || this.buildFeedbackFromCriteria(validation),
      };
    }

    // Rule 3: Out of retries
    const lastFailure = validation.feedback || this.buildFeedbackFromCriteria(validation);
    return {
      verdict: 'ABORT',
      reason: `Failed after ${maxAttempts} attempt(s). Last failure: ${lastFailure}`,
    };
  }

  /**
   * If validator didn't provide a feedback string, build one from individual criteria.
   */
  private buildFeedbackFromCriteria(validation: ValidationResult): string {
    const failed = validation.criteria_results
      .filter(c => !c.passed)
      .map(c => {
        const detail = c.detail ? `: ${c.detail}` : '';
        return `- FAIL: ${c.criterion}${detail}`;
      });

    if (failed.length === 0) {
      return 'Validation failed but no specific criteria failures reported.';
    }

    return `${failed.length} criterion/criteria failed:\n${failed.join('\n')}`;
  }
}
