// Router unit tests — pure logic, no excuses.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../runtime/router.js';
import type { ValidationResult } from '../runtime/types.js';

const router = new Router();

// ── Helpers ──

function makeValidation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    task_id: 'test-task',
    passed: false,
    criteria_results: [],
    feedback: '',
    raw_output: '',
    ...overrides,
  };
}

function passedValidation(): ValidationResult {
  return makeValidation({
    passed: true,
    criteria_results: [
      { criterion: 'File exists', passed: true },
      { criterion: 'Tests pass', passed: true },
    ],
  });
}

function failedValidation(feedback?: string): ValidationResult {
  return makeValidation({
    passed: false,
    criteria_results: [
      { criterion: 'File exists', passed: true },
      { criterion: 'Tests pass', passed: false, detail: 'AssertionError in test_models' },
    ],
    feedback: feedback ?? 'Tests failed: AssertionError in test_models',
  });
}

// ── Rule 1: PASS ──

describe('Router — Rule 1: PASS when all criteria pass', () => {
  it('returns PASS on first attempt', () => {
    const v = router.route(passedValidation(), 1, 5);
    assert.equal(v.verdict, 'PASS');
    assert.equal(v.feedback, undefined);
    assert.equal(v.reason, undefined);
  });

  it('returns PASS on last attempt', () => {
    const v = router.route(passedValidation(), 5, 5);
    assert.equal(v.verdict, 'PASS');
  });

  it('returns PASS even on attempt beyond max (edge case)', () => {
    // If somehow called with attempt > max but passed, still PASS
    const v = router.route(passedValidation(), 10, 5);
    assert.equal(v.verdict, 'PASS');
  });
});

// ── Rule 2: REVISE ──

describe('Router — Rule 2: REVISE when failed but retries remain', () => {
  it('returns REVISE on attempt 1 of 5', () => {
    const v = router.route(failedValidation(), 1, 5);
    assert.equal(v.verdict, 'REVISE');
    assert.ok(v.feedback);
    assert.ok(v.feedback!.includes('Tests failed'));
  });

  it('returns REVISE on attempt 4 of 5', () => {
    const v = router.route(failedValidation(), 4, 5);
    assert.equal(v.verdict, 'REVISE');
  });

  it('includes feedback from validation', () => {
    const v = router.route(failedValidation('Fix the FK constraint'), 2, 5);
    assert.equal(v.verdict, 'REVISE');
    assert.equal(v.feedback, 'Fix the FK constraint');
  });

  it('builds feedback from criteria when feedback string is empty', () => {
    const val = makeValidation({
      passed: false,
      criteria_results: [
        { criterion: 'Models exist', passed: true },
        { criterion: 'FK constraints correct', passed: false, detail: 'Missing product_id FK' },
        { criterion: 'Import works', passed: false },
      ],
      feedback: '',
    });
    const v = router.route(val, 1, 3);
    assert.equal(v.verdict, 'REVISE');
    assert.ok(v.feedback!.includes('2 criterion/criteria failed'));
    assert.ok(v.feedback!.includes('FK constraints correct'));
    assert.ok(v.feedback!.includes('Missing product_id FK'));
    assert.ok(v.feedback!.includes('Import works'));
  });
});

// ── Rule 3: ABORT ──

describe('Router — Rule 3: ABORT when max attempts exceeded', () => {
  it('returns ABORT on attempt 5 of 5', () => {
    const v = router.route(failedValidation(), 5, 5);
    assert.equal(v.verdict, 'ABORT');
    assert.ok(v.reason);
    assert.ok(v.reason!.includes('Failed after 5 attempt(s)'));
  });

  it('returns ABORT on attempt 1 of 1 (single-shot)', () => {
    const v = router.route(failedValidation(), 1, 1);
    assert.equal(v.verdict, 'ABORT');
    assert.ok(v.reason!.includes('Failed after 1 attempt(s)'));
  });

  it('includes last failure info in reason', () => {
    const v = router.route(failedValidation('DB connection refused'), 3, 3);
    assert.equal(v.verdict, 'ABORT');
    assert.ok(v.reason!.includes('DB connection refused'));
  });
});

// ── Edge cases ──

describe('Router — Edge cases', () => {
  it('throws on maxAttempts < 1', () => {
    assert.throws(() => router.route(passedValidation(), 1, 0), /maxAttempts must be >= 1/);
  });

  it('throws on attempt < 1', () => {
    assert.throws(() => router.route(passedValidation(), 0, 5), /attempt must be >= 1/);
  });

  it('handles validation with no criteria results and no feedback', () => {
    const val = makeValidation({ passed: false, criteria_results: [], feedback: '' });
    const v = router.route(val, 1, 3);
    assert.equal(v.verdict, 'REVISE');
    assert.ok(v.feedback!.includes('no specific criteria'));
  });

  it('PASS always takes priority over attempt count', () => {
    // Even if attempt == maxAttempts, if passed, it's PASS
    const v = router.route(passedValidation(), 5, 5);
    assert.equal(v.verdict, 'PASS');
  });
});
