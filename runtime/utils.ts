// Synapse Forge v0.4 — File utilities
// Carried forward from v0.3: atomic writes, structured errors, archive, metadata.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Error types for safeReadJSON ──

export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'PARSE_ERROR'; detail: string }
  | { ok: false; error: 'VALIDATION_ERROR'; detail: string };

export function safeReadJSON<T = unknown>(
  filePath: string,
  requiredFields?: string[],
): ReadResult<T> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'NOT_FOUND' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    return { ok: false, error: 'PARSE_ERROR', detail: e.message };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    return { ok: false, error: 'PARSE_ERROR', detail: `JSON.parse failed: ${e.message}` };
  }

  if (requiredFields) {
    for (const field of requiredFields) {
      if (!(field in parsed)) {
        return { ok: false, error: 'VALIDATION_ERROR', detail: `Missing required field: ${field}` };
      }
    }
  }

  return { ok: true, data: parsed as T };
}

// ── Atomic write: write to .tmp then rename ──

export function safeWriteJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = path.join(dir, `.tmp_${crypto.randomUUID().slice(0, 8)}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ── Archive instead of delete ──

export function archiveFile(filePath: string, archiveDir: string): void {
  if (!fs.existsSync(filePath)) return;

  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const basename = path.basename(filePath, '.json');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(archiveDir, `${basename}_${timestamp}.json`);

  try {
    fs.renameSync(filePath, dest);
  } catch {
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
  }
}

// ── Simple utilities ──

export function safeDelete(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

export function fileExists(filePath: string): boolean {
  try { return fs.existsSync(filePath); } catch { return false; }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Metadata envelope ──

export type Producer = 'forge' | 'generator' | 'validator' | 'decomposer' | 'reviewer';

export function withMeta(
  data: Record<string, any>,
  producer: Producer,
  taskId?: string,
  attempt?: number,
): Record<string, any> {
  return {
    message_id: crypto.randomUUID(),
    task_id: taskId ?? null,
    attempt: attempt ?? null,
    created_at: new Date().toISOString(),
    producer,
    schema_version: '0.4',
    ...data,
  };
}
