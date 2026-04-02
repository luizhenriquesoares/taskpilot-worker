import { spawn } from 'child_process';
import { parseCostFromClaudeOutput } from './cost-parser.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface ClaudeRunResult {
  output: string;
  exitCode: number;
  durationMs: number;
  costUsd: number | null;
}

export interface ClaudeStreamEvent {
  type: 'init' | 'text' | 'tool' | 'result' | 'error';
  data: string;
  timestamp: string;
}

export interface HeadlessRunnerOptions {
  cwd: string;
  prompt: string;
  claudePath?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  /** Called for each stream event — for real-time UI updates */
  onEvent?: (event: ClaudeStreamEvent) => void;
}

/**
 * Spawns Claude CLI in headless mode with stream-json output.
 * Parses events in real-time and calls onEvent for each.
 */
export async function runClaude(options: HeadlessRunnerOptions): Promise<ClaudeRunResult> {
  const {
    cwd,
    prompt,
    claudePath = 'claude',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBudgetUsd,
    onEvent,
  } = options;

  const args = [
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const { signal } = controller;

  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const emit = (type: ClaudeStreamEvent['type'], data: string) => {
    if (onEvent) {
      onEvent({ type, data, timestamp: new Date().toISOString() });
    }
  };

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    const proc = spawn(claudePath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: { ...process.env },
    });

    let stdout = '';
    let resultText = '';
    let buffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;

      // Parse newline-delimited JSON events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const evt = JSON.parse(trimmed);
          parseStreamEvent(evt, emit);

          // Capture result text
          if (evt.type === 'result') {
            resultText = evt.result || '';
          }
        } catch {
          // Not JSON — emit as raw text
          if (trimmed) emit('text', trimmed);
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) emit('error', msg);
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;

      if (err.name === 'AbortError' || signal.aborted) {
        emit('error', `Timed out after ${timeoutMs}ms`);
        resolve({
          output: resultText || stdout,
          exitCode: 124,
          durationMs,
          costUsd: parseCostFromClaudeOutput(stdout),
        });
        return;
      }

      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;

      resolve({
        output: resultText || stdout,
        exitCode: code ?? 1,
        durationMs,
        costUsd: parseCostFromClaudeOutput(stdout),
      });
    });
  });
}

/** Parse a stream-json event and emit human-readable data */
function parseStreamEvent(
  evt: Record<string, unknown>,
  emit: (type: ClaudeStreamEvent['type'], data: string) => void,
): void {
  const type = evt.type as string;

  if (type === 'system' && evt.subtype === 'init') {
    const model = (evt.model as string) || 'unknown';
    const tools = (evt.tools as string[]) || [];
    emit('init', `Model: ${model} | Tools: ${tools.length}`);
  }

  if (type === 'assistant') {
    const msg = evt.message as Record<string, unknown>;
    const content = (msg?.content as Array<Record<string, unknown>>) || [];

    for (const block of content) {
      if (block.type === 'text') {
        const text = (block.text as string) || '';
        if (text.trim()) emit('text', text);
      }

      if (block.type === 'tool_use') {
        const name = block.name as string;
        const input = (block.input as Record<string, unknown>) || {};

        if (name === 'Bash') {
          emit('tool', `$ ${((input.command as string) || '').substring(0, 150)}`);
        } else if (name === 'Read') {
          emit('tool', `[Read] ${input.file_path}`);
        } else if (name === 'Edit') {
          emit('tool', `[Edit] ${input.file_path}`);
        } else if (name === 'Write') {
          emit('tool', `[Write] ${input.file_path}`);
        } else if (name === 'Grep') {
          emit('tool', `[Search] ${input.pattern}`);
        } else if (name === 'Glob') {
          emit('tool', `[Find] ${input.pattern}`);
        } else {
          emit('tool', `[${name}]`);
        }
      }
    }
  }

  if (type === 'result') {
    const cost = (evt.total_cost_usd as number) || 0;
    const dur = ((evt.duration_ms as number) || 0) / 1000;
    const turns = (evt.num_turns as number) || 0;
    emit('result', `Cost: $${cost.toFixed(4)} | Time: ${dur.toFixed(0)}s | Turns: ${turns}`);
  }
}
