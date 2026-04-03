import * as fs from 'fs';
import * as path from 'path';
import { runClaude } from './headless-runner.js';

const KNOWLEDGE_FILE = '.trello-pilot-knowledge.json';
const KNOWLEDGE_CACHE_DIR = '/tmp/trello-pilot-knowledge-cache';
const KNOWLEDGE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const KNOWLEDGE_BUDGET_USD = 0.15;

export interface ProjectKnowledge {
  projectName: string;
  architecture: string;
  techStack: string[];
  fileMap: Record<string, string>;
  patterns: Record<string, string>;
  entities: string[];
  keyFiles: string[];
  lastUpdated: string;
}

export class KnowledgeManager {
  private getKnowledgePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, KNOWLEDGE_FILE);
  }

  /** Get persistent cache path for a repo URL (survives /tmp clone cleanup) */
  private getCachePath(repoUrl: string): string {
    const hash = Buffer.from(repoUrl).toString('base64url').substring(0, 40);
    return path.join(KNOWLEDGE_CACHE_DIR, `${hash}.json`);
  }

  /** Load existing knowledge — checks workDir first, then persistent cache */
  load(workspaceRoot: string, repoUrl?: string): ProjectKnowledge | null {
    // Try workDir first
    const filePath = this.getKnowledgePath(workspaceRoot);
    const knowledge = this.loadFromFile(filePath);
    if (knowledge) return knowledge;

    // Try persistent cache (keyed by repo URL)
    if (repoUrl) {
      const cachePath = this.getCachePath(repoUrl);
      const cached = this.loadFromFile(cachePath);
      if (cached) {
        // Copy to workDir for future stages
        try { fs.writeFileSync(filePath, JSON.stringify(cached, null, 2) + '\n', 'utf-8'); } catch { /* */ }
        return cached;
      }
    }

    return null;
  }

  private loadFromFile(filePath: string): ProjectKnowledge | null {
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const knowledge = JSON.parse(raw) as ProjectKnowledge;

      const age = Date.now() - new Date(knowledge.lastUpdated).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (age > sevenDays) return null;

      return knowledge;
    } catch {
      return null;
    }
  }

  /**
   * Try to load knowledge from an existing CLAUDE.md in the repo.
   * This is faster and more reliable than generating via Claude CLI.
   */
  loadFromClaudeMd(workspaceRoot: string): ProjectKnowledge | null {
    const claudeMdPath = path.join(workspaceRoot, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) return null;

    try {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      if (content.length < 100) return null; // Too short to be useful

      // Build a lightweight knowledge object from CLAUDE.md content
      const knowledge: ProjectKnowledge = {
        projectName: path.basename(workspaceRoot),
        architecture: content.substring(0, 500),
        techStack: [],
        fileMap: {},
        patterns: {},
        entities: [],
        keyFiles: ['CLAUDE.md'],
        lastUpdated: new Date().toISOString(),
      };

      return knowledge;
    } catch {
      return null;
    }
  }

  /** Format CLAUDE.md content directly as prompt context (much richer than generated knowledge) */
  formatClaudeMdForPrompt(workspaceRoot: string): string | null {
    const claudeMdPath = path.join(workspaceRoot, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) return null;

    try {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      if (content.length < 100) return null;

      return [
        '## Project Knowledge (from CLAUDE.md — skip exploratory scanning)',
        '',
        content,
        '',
        '> Use this knowledge to navigate the codebase directly. Only read files you need to modify — do NOT do a full project scan.',
        '',
      ].join('\n');
    } catch {
      return null;
    }
  }

  /** Save knowledge to workDir and persistent cache */
  save(workspaceRoot: string, knowledge: ProjectKnowledge, repoUrl?: string): void {
    const data = JSON.stringify(knowledge, null, 2) + '\n';
    const filePath = this.getKnowledgePath(workspaceRoot);
    fs.writeFileSync(filePath, data, 'utf-8');

    // Also persist to cache dir (survives /tmp cleanup)
    if (repoUrl) {
      try {
        if (!fs.existsSync(KNOWLEDGE_CACHE_DIR)) {
          fs.mkdirSync(KNOWLEDGE_CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(this.getCachePath(repoUrl), data, 'utf-8');
      } catch { /* non-blocking */ }
    }
  }

  /** Generate knowledge by scanning the project via Claude CLI */
  async generate(workspaceRoot: string, _claudePath: string, repoUrl?: string): Promise<ProjectKnowledge | null> {
    const prompt = `Analyze this project's codebase structure and output ONLY valid JSON (no markdown, no explanation, no code fences):
{
  "projectName": "name of the project",
  "architecture": "brief architecture description (1-2 sentences)",
  "techStack": ["list", "of", "technologies"],
  "fileMap": {
    "path/to/important/dir/": "what this directory contains",
    "path/to/key/file.ts": "what this file does"
  },
  "patterns": {
    "patternName": "path pattern where this type of code lives"
  },
  "entities": ["list of main domain entities/models"],
  "keyFiles": ["paths to the most important files a developer should know about"]
}

RULES:
- fileMap: include only the top 15-20 most important directories and files
- patterns: common code locations (controllers, services, components, utils, etc.)
- entities: main business objects (from database schemas, types, interfaces)
- keyFiles: files that any developer needs to understand (main configs, entry points, shared utils)
- Be concise. This is a reference for AI agents implementing tasks.
- Output ONLY the JSON object, nothing else.`;

    try {
      const result = await runClaude({
        cwd: workspaceRoot,
        prompt,
        timeoutMs: KNOWLEDGE_TIMEOUT_MS,
        maxBudgetUsd: KNOWLEDGE_BUDGET_USD,
      });

      if (result.exitCode !== 0) {
        console.warn(`[Knowledge] Claude exited with code ${result.exitCode}`);
        return null;
      }

      // Extract JSON from response (handle code fences and surrounding text)
      const output = result.output
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '');
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[Knowledge] No JSON found in Claude output');
        return null;
      }

      const knowledge = JSON.parse(jsonMatch[0]) as ProjectKnowledge;
      knowledge.lastUpdated = new Date().toISOString();

      this.save(workspaceRoot, knowledge, repoUrl);
      return knowledge;
    } catch (err) {
      console.warn(`[Knowledge] Generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Format knowledge as prompt context */
  formatForPrompt(knowledge: ProjectKnowledge): string {
    const sections: string[] = [];

    sections.push('## Project Knowledge (cached — skip exploratory scanning)');
    sections.push('');
    sections.push(`**Architecture:** ${knowledge.architecture}`);
    sections.push(`**Tech Stack:** ${knowledge.techStack.join(', ')}`);
    sections.push('');

    sections.push('### Key Files');
    for (const file of knowledge.keyFiles) {
      sections.push(`- \`${file}\``);
    }
    sections.push('');

    sections.push('### File Map');
    for (const [filePath, desc] of Object.entries(knowledge.fileMap)) {
      sections.push(`- \`${filePath}\` — ${desc}`);
    }
    sections.push('');

    sections.push('### Code Patterns');
    for (const [pattern, location] of Object.entries(knowledge.patterns)) {
      sections.push(`- **${pattern}:** \`${location}\``);
    }
    sections.push('');

    sections.push('### Entities');
    sections.push(knowledge.entities.join(', '));
    sections.push('');

    sections.push('> Use this knowledge to navigate the codebase directly. Only read files you need to modify — do NOT do a full project scan.');
    sections.push('');

    return sections.join('\n');
  }
}
