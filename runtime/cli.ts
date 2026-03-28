#!/usr/bin/env tsx
// Synapse Forge v0.4 — CLI Entry Point

import fs from 'node:fs';
import path from 'node:path';
import { SynapseForge } from './forge.js';
import { safeReadJSON } from './utils.js';
import type { ForgeConfig } from './types.js';

const DEFAULT_CONFIG: ForgeConfig = {
  generator: {
    command: 'claude',
    args: ['--print', '--model', 'opus'],
    timeout_ms: 600000,
    max_attempts: 5,
  },
  validator: {
    command: 'codex',
    args: ['--model', 'o3', '--approval-mode', 'full-auto'],
    timeout_ms: 300000,
  },
  decomposer: {
    command: 'claude',
    args: ['-p', '--output-format', 'json', '--model', 'opus'],
    timeout_ms: 300000,
  },
  reviewer: {
    command: 'claude',
    args: ['-p', '--output-format', 'json', '--model', 'opus'],
    timeout_ms: 300000,
  },
  notification: {
    type: 'file',
  },
  max_parallel_tasks: 3,
  project_dir: './output',
  synapse_dir: './.synapse',
};

function loadConfig(): ForgeConfig {
  const configPath = path.resolve('forge.config.json');
  const result = safeReadJSON<Partial<ForgeConfig>>(configPath);

  if (result.ok) {
    console.log(`[CLI] Loaded config from ${configPath}`);
    return { ...DEFAULT_CONFIG, ...result.data } as ForgeConfig;
  }

  console.log('[CLI] No forge.config.json found, using defaults');
  return DEFAULT_CONFIG;
}

function printHelp(): void {
  console.log(`
Synapse Forge v0.4 — Unmanned Delivery Pipeline

Usage:
  npx synapse-forge run    --requirements <path>   Full pipeline
  npx synapse-forge plan   --requirements <path>   Decompose only (outputs plan.json)
  npx synapse-forge execute --plan <path>           Execute existing plan
  npx synapse-forge resume                          Resume from interruption
  npx synapse-forge status                          Show current state

Options:
  --requirements, -r   Path to requirements.json
  --plan, -p           Path to plan.json
  --config, -c         Path to forge.config.json (default: ./forge.config.json)
  --help, -h           Show this help
`);
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') || arg.startsWith('-')) {
      const key = arg.replace(/^-+/, '');
      flags[key] = args[i + 1] || '';
      i++;
    }
  }

  return { command, flags };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (command === 'help' || flags.help || flags.h) {
    printHelp();
    return;
  }

  const config = loadConfig();

  // Override config from flags
  if (flags.config || flags.c) {
    const customConfig = safeReadJSON<Partial<ForgeConfig>>(flags.config || flags.c);
    if (customConfig.ok) {
      Object.assign(config, customConfig.data);
    }
  }

  const forge = new SynapseForge(config);

  switch (command) {
    case 'run': {
      const reqPath = flags.requirements || flags.r;
      if (!reqPath) {
        console.error('Error: --requirements <path> is required');
        process.exit(1);
      }
      await forge.run(reqPath);
      break;
    }

    case 'plan': {
      const reqPath = flags.requirements || flags.r;
      if (!reqPath) {
        console.error('Error: --requirements <path> is required');
        process.exit(1);
      }
      const plan = await forge.plan(reqPath);
      console.log(`Plan written to ${config.synapse_dir}/plan.json (${plan.tasks.length} tasks)`);
      break;
    }

    case 'execute': {
      const planPath = flags.plan || flags.p || path.join(config.synapse_dir, 'plan.json');
      await forge.execute(planPath);
      break;
    }

    case 'resume': {
      await forge.resume();
      break;
    }

    case 'status': {
      forge.status();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n[Forge] Fatal error: ${err.message}`);
  process.exit(1);
});
