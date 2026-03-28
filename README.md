# Synapse Forge v0.4

**Autonomous Delivery Pipeline — unmanned code generation with heterogeneous LLM validation.**

[English](#why) | [中文](#为什么)

Synapse Forge is a task execution framework where a human defines requirements, an LLM decomposes them into subtasks, and two different CLI agents (one generates, one validates) iterate in an unmanned loop until all tests pass. Nobody watches the execution. You get notified when it's done.

```
Human ←→ LLM (define requirements)
            │
            │  human leaves
            ▼
         LLM (decompose → plan.json)
            │
            │  LLM leaves
            ▼
   ┌──────────────────────────────┐
   │  Unmanned Execution          │
   │                              │
   │  Claude CLI → writes code    │
   │       ▲              │       │
   │       │ feedback      ▼       │
   │       └─────── Codex CLI     │
   │         (test + debug)       │
   │                              │
   │  loop until all tests pass   │
   └──────────────┬───────────────┘
                  │
                  ▼
         LLM (final review)
                  │
                  ▼
         Notify human: "done"
```

## Why

Existing agent frameworks (OpenHands, Devin, Claude Code Agent Teams) have one fundamental flaw: **the same model writes code and judges its own output.** This is a student grading their own exam.

Synapse Forge separates generation from validation:

- **Generator** (Claude CLI) writes code. That's all it does.
- **Validator** (Codex CLI) tests code. Different model, different biases, different blind spots.
- **Router** decides pass/fail. Three lines of `if/else`. No LLM, no subjectivity. Tests pass or they don't.

The human and the LLM are both **removed from the execution loop**. They appear at the beginning (requirements) and the end (review). The middle is two CLI processes arguing with each other through structured files.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  forge.ts                        │
│              (Node.js orchestrator)              │
│                                                  │
│  Phase 2: DECOMPOSE                              │
│    spawn claude CLI → plan.json                  │
│                                                  │
│  Phase 3: EXECUTE (unmanned loop)                │
│    for each task:                                │
│      generator.ts → spawn claude CLI → code      │
│      validator.ts → spawn codex CLI → test       │
│      router.ts → PASS / REVISE / ABORT           │
│      if REVISE: feed back, retry                 │
│                                                  │
│  Phase 4: REVIEW                                 │
│    spawn claude CLI → review.json                │
│                                                  │
│  Phase 5: DELIVER                                │
│    notifier.ts → webhook / file                  │
└─────────────────────────────────────────────────┘
```

All LLM calls = `spawn` a CLI child process + read `stdout`. Zero API calls. Zero API costs. Everything runs on your existing Claude Max / Codex subscription.

## Components

| File | Lines | Role |
|------|-------|------|
| `forge.ts` | 290 | Main orchestrator — parallel execution with semaphore, dependency resolution, phase management |
| `decomposer.ts` | 170 | Spawns Claude CLI to break requirements into a task graph with per-task prompts and test criteria |
| `generator.ts` | 150 | Spawns Claude CLI to write code for a single task. Injects feedback on retries |
| `validator.ts` | 210 | Spawns Codex CLI to test generated code. Falls back to direct shell execution if Codex unavailable |
| `router.ts` | 57 | Pure logic — pass/fail/retry based on test results and attempt count. No LLM |
| `reviewer.ts` | 165 | Spawns Claude CLI for one-shot final review against original requirements |
| `context.ts` | 105 | File-based pattern matching — decomposition templates + accumulated feedback history |
| `notifier.ts` | 70 | Webhook POST or local file drop when pipeline completes |
| `cli.ts` | 130 | CLI entry point — `run`, `plan`, `execute`, `resume`, `status` commands |
| `types.ts` | 130 | TypeScript types for all protocol structures |
| `utils.ts` | 117 | Atomic file writes, safe JSON read/write, metadata envelopes (from Synapse v0.3) |

## Install

```bash
git clone https://github.com/patchworkai/synapse-forge.git
cd synapse-forge
npm install
```

### Prerequisites

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (optional — falls back to shell execution)

## Usage

### Full pipeline

```bash
# Write or generate a requirements.json (see below for format)
npx synapse-forge run --requirements ./requirements.json
```

This runs all 5 phases: decompose → execute → review → notify. You can walk away after running this command.

### Step by step

```bash
# Phase 2 only — decompose requirements into plan, review before executing
npx synapse-forge plan --requirements ./requirements.json

# Phase 3-5 — execute an existing plan
npx synapse-forge execute --plan ./.synapse/plan.json

# Resume after interruption (reads .synapse/history.json)
npx synapse-forge resume

# Check progress of a running pipeline
npx synapse-forge status
```

## requirements.json

The input contract. Write this yourself or generate it through an LLM conversation.

```json
{
  "project": "my-project",
  "description": "What you want built, in plain language",
  "tech_stack": {
    "backend": "FastAPI + SQLAlchemy",
    "frontend": "React + TailwindCSS",
    "deployment": "Docker Compose"
  },
  "acceptance_criteria": [
    "Specific, testable criteria that define 'done'",
    "Each criterion should be verifiable by running a command",
    "docker-compose up starts the full stack without errors"
  ],
  "constraints": [
    "Any hard constraints on implementation"
  ],
  "output_dir": "./my-project"
}
```

The quality of your requirements determines the quality of the output. Be specific about acceptance criteria — the validator will literally run these as tests.

## Configuration

`forge.config.json` in project root:

```json
{
  "generator": {
    "command": "claude",
    "args": ["--model", "opus", "--output-format", "json"],
    "timeout_ms": 600000,
    "max_attempts": 5
  },
  "validator": {
    "command": "codex",
    "args": ["--model", "o3", "--approval-mode", "full-auto"],
    "timeout_ms": 300000
  },
  "decomposer": {
    "command": "claude",
    "args": ["-p", "--output-format", "json", "--model", "opus"],
    "timeout_ms": 300000
  },
  "reviewer": {
    "command": "claude",
    "args": ["-p", "--output-format", "json", "--model", "opus"],
    "timeout_ms": 300000
  },
  "notification": {
    "type": "webhook",
    "url": "https://your-webhook.com/forge-done"
  },
  "max_parallel_tasks": 2,
  "project_dir": "./output",
  "synapse_dir": "./.synapse"
}
```

All `command` fields are CLI executables. Swap `claude` for any LLM CLI. Swap `codex` for any testing tool. The framework doesn't care what's inside the box — only that it reads stdin/args and writes stdout.

## Context System

```
context/
├── patterns/              # Decomposition templates
│   ├── fullstack-app.md
│   ├── data-pipeline.md
│   └── api-service.md
└── feedback-history/      # Accumulated correction patterns
    ├── backend-models_1711612800.json
    └── frontend_1711613400.json
```

**Patterns** are markdown templates for decomposing common project types. The decomposer matches by keyword.

**Feedback history** accumulates automatically. Every failed-then-corrected task saves its feedback. Future similar tasks get this context injected. The system gets better the more you use it.

No vector database. No embeddings. Just files and string matching.

## How It Differs from v0.3

| | Synapse v0.3 | Synapse Forge v0.4 |
|---|---|---|
| **Verdict source** | Same LLM via Playwright browser automation | Different LLM (Codex) + rule-based router |
| **Human in loop** | Required (browser must stay open) | Not required (unmanned execution) |
| **LLM in loop** | Entire execution (every task verdict) | Only decompose + final review |
| **Execution** | Serial | Parallel (semaphore-controlled) |
| **LLM communication** | Playwright → browser → chat UI | spawn CLI → read stdout |
| **Dependencies** | Playwright, browser | None (Node.js + CLI tools) |
| **API costs** | Per-call API pricing | Zero (CLI on subscription) |
| **Recovery** | Fragile (browser crash = restart) | Robust (file-based state, resume) |

## Design Principles

**CLI is the universal agent interface.** Every LLM provider ships a CLI. `spawn` + `stdout` is the POSIX of the AI era.

**Files are the only integration surface.** The `.synapse/` directory is the sole communication channel. Any tool that reads and writes JSON files is a valid Forge component.

**The router has no intelligence.** Tests pass or they don't. This is the most reliable component because it cannot hallucinate.

**LLMs are expensive consultants.** Bring them in for planning and review. Don't let them watch the construction.

---

# 中文说明

## 为什么

现有的AI代码框架（OpenHands、Devin、Claude Code Agent Teams）有一个根本缺陷：**同一个模型既写代码又评判自己的输出。** 这相当于考生给自己批卷子。

Synapse Forge把生成和验证分开：

- **生成器**（Claude CLI）只写代码
- **验证器**（Codex CLI）只测试代码。不同模型，不同偏见，不同盲区
- **路由器**决定通过/重试/终止。三行`if/else`。没有LLM，没有主观判断。测试过了就是过了

人和LLM都**不在执行循环里**。他们只在开头（定需求）和结尾（做审查）出现。中间是两个CLI进程通过结构化文件互相"对质"。

## 核心思路

所有LLM调用 = 启动CLI子进程 + 读stdout。零API调用。零额外费用。全部跑在你现有的Claude Max / Codex订阅上。

## 使用方式

```bash
# 安装
git clone https://github.com/patchworkai/synapse-forge.git
cd synapse-forge && npm install

# 完整流程（跑完可以走人）
npx synapse-forge run --requirements ./requirements.json

# 只做分解（看看plan再决定执行）
npx synapse-forge plan --requirements ./requirements.json

# 执行已有计划
npx synapse-forge execute --plan ./.synapse/plan.json

# 中断后恢复
npx synapse-forge resume

# 查看进度
npx synapse-forge status
```

## 前置条件

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并登录
- [Codex CLI](https://github.com/openai/codex) 已安装并登录（可选——没有的话自动降级为shell执行）

## 与v0.3的区别

v0.3通过Playwright操控浏览器来获取LLM的判定——必须有人开着浏览器，一崩就全完。

v0.4把浏览器自动化全部撕掉，换成CLI原生执行。验证交给不同的模型（Codex），判定用纯逻辑路由器。支持并行执行、断点恢复、webhook通知。零外部依赖。

## 设计原则

**CLI是通用的Agent接口。** 每个LLM厂商都出CLI。`spawn` + `stdout`是AI时代的POSIX。

**文件是唯一的集成界面。** `.synapse/`目录是所有组件的唯一通信通道。

**路由器没有智能。** 测试过了就是过了。这是系统里最可靠的组件，因为它不会产生幻觉。

**LLM是昂贵的顾问。** 让他们做规划和审查。别让他们盯着施工现场。

---

## Lineage

Synapse Forge evolves from [Synapse v0.3](https://github.com/patchworkai/synapse), a feedback-driven async task execution protocol. The core file protocol (`.synapse/` directory, atomic writes, metadata envelopes, heartbeat mechanism) is carried forward unchanged. The browser automation layer is replaced with CLI-native execution.

Built by [Noogenesis Research](https://github.com/noogenesis-research).

## License

MIT
