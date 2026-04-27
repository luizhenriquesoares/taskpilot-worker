import * as fs from 'fs';
import * as path from 'path';
import { RepoManager } from '../../git/repo-manager.js';
import { TrelloApi } from '../../trello/api.js';
import { PromptBuilder } from '../../claude/prompt-builder.js';
import { runClaude, type ClaudeStreamEvent } from '../../claude/headless-runner.js';
import { KnowledgeManager } from '../../claude/knowledge.js';
import { WorkspaceBootstrapper } from '../../claude/workspace-bootstrapper.js';
import { TrelloCommenter } from '../../notifications/trello-commenter.js';
import type { WorkerEvent } from '../../shared/types/worker-event.js';
import type { TrelloCard } from '../../trello/types.js';

const WORK_DIR_PREFIX = '/tmp/trello-pilot';
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

export interface ImplementResult {
  branchName: string;
  prUrl: string;
  workDir: string;
  costUsd: number;
  durationMs: number;
  commitSummary: string;
}

export class ImplementStage {
  private readonly promptBuilder: PromptBuilder;
  private readonly knowledgeMgr: KnowledgeManager;
  private readonly workspaceBootstrapper: WorkspaceBootstrapper;

  constructor(
    private readonly repoManager: RepoManager,
    private readonly trelloApi: TrelloApi,
    private readonly commenter: TrelloCommenter,
  ) {
    this.promptBuilder = new PromptBuilder();
    this.knowledgeMgr = new KnowledgeManager();
    this.workspaceBootstrapper = new WorkspaceBootstrapper();
  }

  async execute(event: WorkerEvent, onEvent?: (e: ClaudeStreamEvent) => void): Promise<ImplementResult> {
    const startTime = Date.now();
    this.promptBuilder.reset();

    const card = await this.fetchFullCard(event.cardId);
    const { repoUrl, baseBranch, branchPrefix, rules } = event;

    if (rules.length > 0) {
      this.promptBuilder.setRules(rules);
    }

    // Clone repo to temp directory
    const workDir = `${WORK_DIR_PREFIX}-${event.cardId}-${Date.now()}`;
    console.log(`[Implement] Cloning ${repoUrl} to ${workDir}`);
    await this.repoManager.clone(repoUrl, workDir, baseBranch);

    // Create feature branch
    const branchName = this.promptBuilder.buildBranchName(card, branchPrefix);
    console.log(`[Implement] Creating branch: ${branchName}`);
    await this.repoManager.createBranch(workDir, branchName);

    // Load or generate project knowledge
    await this.ensureKnowledge(workDir, repoUrl);

    const workspace = await this.workspaceBootstrapper.prepare(workDir);
    this.promptBuilder.setWorkspaceContext(workspace.promptContext);
    if (onEvent) {
      onEvent({
        type: 'text',
        data: `[bootstrap] workspace preparado com ${workspace.projects.length} diretório(s) de projeto mapeados`,
        timestamp: new Date().toISOString(),
      });
    }

    // Download image attachments for visual context
    const imagePaths = await this.downloadImageAttachments(card, workDir);
    if (imagePaths.length > 0) {
      this.promptBuilder.setImagePaths(imagePaths);
      console.log(`[Implement] ${imagePaths.length} image(s) attached for context`);
    }

    // Build prompt — use retry prompt if this is a reopened task
    const prompt = event.isRetry && event.retryFeedback
      ? this.promptBuilder.buildRetry(card, event.retryFeedback)
      : this.promptBuilder.build(card);

    const modeLabel = event.isRetry ? 'RETRY' : 'IMPLEMENT';
    console.log(`[Implement] Running Claude headless (${modeLabel}) for card: ${card.name}`);

    const runResult = await runClaude({
      cwd: workDir,
      prompt,
      onEvent,
    });

    const costUsd = runResult.costUsd ?? 0;

    if (runResult.exitCode !== 0) {
      console.warn(`[Implement] Claude exited with code ${runResult.exitCode}`);
    }

    // Check if there are commits to push
    let commitLog = '';
    try {
      commitLog = await this.repoManager.getCommitLog(workDir);
    } catch {
      // getCommitLog may fail if on main with no diff — leave commitLog empty
      console.warn('[Implement] Could not get commit log — assuming no commits');
    }

    if (!commitLog.trim()) {
      // Claude produced nothing on this branch. Don't push, don't create a PR,
      // and don't pretend a previous run exists — the orchestrator's guard will
      // halt the pipeline before REVIEW so a human can decide what to do.
      console.warn('[Implement] No commits on branch — returning empty result; pipeline will halt before REVIEW');
      return {
        branchName,
        prUrl: '',
        workDir,
        costUsd,
        durationMs: Date.now() - startTime,
        commitSummary: '',
      };
    }

    // Push and create PR
    console.log(`[Implement] Pushing branch: ${branchName}`);
    await this.repoManager.push(workDir, branchName);

    const prBody = [
      `## Trello Card`,
      card.url,
      '',
      `## Changes`,
      commitLog,
      '',
      '---',
      '_Automated by Trello Pilot Worker_',
    ].join('\n');

    let prUrl = '';
    try {
      prUrl = (await this.repoManager.getPrUrl(workDir, branchName)) ?? '';
    } catch { /* ignore */ }

    if (prUrl) {
      console.log(`[Implement] Reusing existing PR: ${prUrl}`);
    } else {
      try {
        const prInfo = await this.repoManager.createPr(
          workDir,
          card.name,
          prBody,
          baseBranch,
          branchName,
        );
        prUrl = prInfo.url;
        console.log(`[Implement] PR created: ${prUrl}`);
      } catch (err) {
        console.warn(`[Implement] PR creation failed: ${(err as Error).message}`);
        // PR may already exist — try to find it
        try {
          prUrl = (await this.repoManager.getPrUrl(workDir, branchName)) ?? '';
        } catch { /* ignore */ }
      }
    }

    // Comment on Trello and move card
    const durationMs = Date.now() - startTime;
    await this.commenter.postImplementComplete(card.id, {
      branchName,
      prUrl,
      durationMs,
      costUsd,
      projectName: event.projectName,
    });

    return {
      branchName,
      prUrl,
      workDir,
      costUsd,
      durationMs,
      commitSummary: commitLog.trim(),
    };
  }

  private async fetchFullCard(cardId: string): Promise<TrelloCard> {
    const [card, checklists] = await Promise.all([
      this.trelloApi.getCard(cardId),
      this.trelloApi.getCardChecklists(cardId),
    ]);
    card.checklists = checklists;
    return card;
  }

  private async ensureKnowledge(workDir: string, repoUrl?: string): Promise<void> {
    // Priority 1: Use existing CLAUDE.md from the repo (richest context, zero cost)
    const claudeMdContext = this.knowledgeMgr.formatClaudeMdForPrompt(workDir);
    if (claudeMdContext) {
      console.log('[Implement] Using CLAUDE.md from repo as project knowledge');
      this.promptBuilder.setKnowledge(claudeMdContext);
      return;
    }

    // Priority 2: Load cached knowledge (workDir or persistent cache by repo URL)
    let knowledge = this.knowledgeMgr.load(workDir, repoUrl);
    if (knowledge) {
      console.log(`[Implement] Knowledge loaded (${knowledge.techStack.join(', ')})`);
      this.promptBuilder.setKnowledge(this.knowledgeMgr.formatForPrompt(knowledge));
      return;
    }

    // Priority 3: Generate knowledge via Claude CLI
    console.log('[Implement] Generating project knowledge (first run)...');
    knowledge = await this.knowledgeMgr.generate(workDir, 'claude', repoUrl);
    if (knowledge) {
      console.log(`[Implement] Generated: ${knowledge.architecture}`);
      this.promptBuilder.setKnowledge(this.knowledgeMgr.formatForPrompt(knowledge));
    } else {
      console.log('[Implement] Could not generate knowledge — will scan normally');
    }
  }

  private async downloadImageAttachments(card: TrelloCard, workDir: string): Promise<{ name: string; filePath: string }[]> {
    const imageAtts = card.attachments?.filter((att) => {
      return IMAGE_EXTENSIONS.test(att.name);
    });
    if (!imageAtts?.length) return [];

    const imgDir = path.join(workDir, '.trello-pilot-images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    const downloaded: { name: string; filePath: string }[] = [];

    for (const att of imageAtts) {
      try {
        const response = await fetch(att.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) continue;

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_IMAGE_SIZE) continue;

        const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
        const filePath = path.join(imgDir, `${att.id}_${safeName}`);
        fs.writeFileSync(filePath, buffer);
        downloaded.push({ name: att.name, filePath });
      } catch {
        // Non-blocking — skip failed downloads
      }
    }

    return downloaded;
  }

  private async estimateComplexity(
    card: TrelloCard,
    workDir: string,
  ): Promise<{ size: string; reasoning: string; estimatedMinutes: number } | null> {
    try {
      const prompt = [
        'Analyze this task and estimate complexity.',
        `Task: "${card.name}".`,
        `Description: "${card.desc || 'none'}".`,
        'Respond with ONLY valid JSON (no markdown, no code fences):',
        '{"size":"S|M|L|XL","reasoning":"brief reason","estimatedMinutes":N}',
      ].join(' ');

      const result = await runClaude({
        cwd: workDir,
        prompt,
        timeoutMs: 2 * 60 * 1000, // 2 min max
        maxBudgetUsd: 0.05,
      });

      // Strip code fences and stream-json event lines, then extract the response JSON
      const output = result.output
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '');

      // Try to find a JSON object with the expected "size" field
      // (avoids matching stream-json events like init/result)
      const jsonObjects = output.match(/\{[^{}]*\}/g) || [];
      for (const candidate of jsonObjects) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.size && parsed.estimatedMinutes !== undefined) {
            return parsed;
          }
        } catch { /* not valid JSON, skip */ }
      }
      console.warn('[Implement] No valid complexity JSON found in output');
    } catch (err) {
      console.warn(`[Implement] Complexity estimation failed: ${(err as Error).message}`);
    }
    return null;
  }
}
