import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.output',
  'out',
  'tmp',
  'vendor',
]);

const PRIORITY_DIRS = ['.', 'backend', 'frontend', 'client', 'server', 'web', 'app'];
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

interface PackageJsonLike {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface WorkspaceProject {
  relativePath: string;
  packageName: string;
  hasTsconfig: boolean;
  hasNodeModules: boolean;
  hasLockFile: boolean;
  typecheckCommand: string | null;
  testCommand: string | null;
  installStatus: 'already_present' | 'installed' | 'skipped' | 'failed';
  installCommand: string | null;
  installError: string | null;
}

export interface WorkspaceBootstrapResult {
  projects: WorkspaceProject[];
  promptContext: string;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class WorkspaceBootstrapper {
  async prepare(workDir: string): Promise<WorkspaceBootstrapResult> {
    const projectDirs = await this.findProjectDirs(workDir, 2);
    const projects: WorkspaceProject[] = [];

    for (const dir of projectDirs) {
      const project = await this.inspectProject(workDir, dir);
      if (!project) continue;

      if (this.shouldInstall(project, dir)) {
        const installResult = await this.installDependencies(dir, project);
        project.installStatus = installResult.ok ? 'installed' : 'failed';
        project.installError = installResult.ok ? null : installResult.error;
      }

      projects.push(project);
    }

    return {
      projects,
      promptContext: this.buildPromptContext(projects),
    };
  }

  private async findProjectDirs(root: string, maxDepth: number): Promise<string[]> {
    const found: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        found.push(dir);
      }

      if (depth >= maxDepth) return;

      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        await walk(path.join(dir, entry.name), depth + 1);
      }
    };

    await walk(root, 0);

    return [...new Set(found)].sort((a, b) => {
      const relA = path.relative(root, a) || '.';
      const relB = path.relative(root, b) || '.';
      const idxA = PRIORITY_DIRS.indexOf(relA);
      const idxB = PRIORITY_DIRS.indexOf(relB);

      if (idxA !== -1 || idxB !== -1) {
        return (idxA === -1 ? Number.MAX_SAFE_INTEGER : idxA)
          - (idxB === -1 ? Number.MAX_SAFE_INTEGER : idxB);
      }

      return relA.localeCompare(relB);
    });
  }

  private async inspectProject(workDir: string, dir: string): Promise<WorkspaceProject | null> {
    const packageJsonPath = path.join(dir, 'package.json');
    let pkg: PackageJsonLike;

    try {
      pkg = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as PackageJsonLike;
    } catch {
      return null;
    }

    const relativePath = path.relative(workDir, dir) || '.';
    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hasTsconfig = fs.existsSync(path.join(dir, 'tsconfig.json'));
    const hasNodeModules = fs.existsSync(path.join(dir, 'node_modules'));
    const hasLockFile = fs.existsSync(path.join(dir, 'package-lock.json'))
      || fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'));
    const hasMeaningfulTestScript = this.hasMeaningfulTestScript(scripts.test);
    const usesVitest = 'vitest' in deps;
    const usesJest = 'jest' in deps || 'ts-jest' in deps;
    const typecheckCommand = hasTsconfig ? 'npm exec tsc -- --noEmit' : null;

    let testCommand: string | null = null;
    if (hasMeaningfulTestScript) {
      testCommand = 'npm test';
    } else if (usesVitest) {
      testCommand = 'npm exec vitest run';
    } else if (usesJest) {
      testCommand = 'npm exec jest --passWithNoTests';
    }

    return {
      relativePath,
      packageName: pkg.name || path.basename(dir),
      hasTsconfig,
      hasNodeModules,
      hasLockFile,
      typecheckCommand,
      testCommand,
      installStatus: hasNodeModules ? 'already_present' : 'skipped',
      installCommand: this.getInstallCommand(hasLockFile),
      installError: null,
    };
  }

  private hasMeaningfulTestScript(testScript: string | undefined): boolean {
    if (!testScript) return false;
    const normalized = testScript.trim().toLowerCase();
    return normalized.length > 0 && !normalized.includes('no test specified');
  }

  private shouldInstall(project: WorkspaceProject, dir: string): boolean {
    if (project.hasNodeModules) return false;
    if (!project.installCommand) return false;

    const packageJsonPath = path.join(dir, 'package.json');
    let pkg: PackageJsonLike | null = null;
    try {
      pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJsonLike;
    } catch {
      return false;
    }

    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hasValidationTool = 'typescript' in deps || 'vitest' in deps || 'jest' in deps || 'ts-jest' in deps;
    const hasBuildScript = typeof scripts.build === 'string' && scripts.build.trim().length > 0;
    const hasTestScript = this.hasMeaningfulTestScript(scripts.test);

    return project.hasTsconfig || hasValidationTool || hasBuildScript || hasTestScript;
  }

  private getInstallCommand(hasLockFile: boolean): string {
    if (hasLockFile) {
      return 'npm ci --include=dev --no-audit --no-fund --prefer-offline';
    }
    return 'npm install --include=dev --no-audit --no-fund --prefer-offline';
  }

  private async installDependencies(
    cwd: string,
    project: WorkspaceProject,
  ): Promise<{ ok: boolean; error?: string }> {
    const command = project.installCommand;
    if (!command) return { ok: false, error: 'No install command available' };

    console.log(`[Bootstrap] Installing dependencies in ${project.relativePath} with: ${command}`);
    const [bin, ...args] = command.split(' ');
    const result = await this.exec(cwd, bin, args, INSTALL_TIMEOUT_MS);

    if (result.exitCode === 0) {
      console.log(`[Bootstrap] Dependencies ready in ${project.relativePath}`);
      return { ok: true };
    }

    const error = result.stderr || result.stdout || `Install failed with exit ${result.exitCode}`;
    console.warn(`[Bootstrap] Failed in ${project.relativePath}: ${error}`);
    return { ok: false, error };
  }

  private exec(cwd: string, bin: string, args: string[], timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve) => {
      const proc = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'development', CI: '1' },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGTERM');
        resolve({
          exitCode: 124,
          stdout: stdout.trim(),
          stderr: (stderr || `Timed out after ${timeoutMs}ms`).trim(),
        });
      }, timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode: 1,
          stdout: stdout.trim(),
          stderr: `${stderr}\n${err.message}`.trim(),
        });
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });
  }

  private buildPromptContext(projects: WorkspaceProject[]): string {
    const lines: string[] = [];
    lines.push('## Workspace Map');
    lines.push('The worker already inspected and prepared this repository for you.');
    lines.push('Read this section BEFORE running validation commands.');
    lines.push('- Do NOT repeatedly probe for `tsc`, `vitest`, or `jest`.');
    lines.push('- Do NOT run `npm install`, `npm ci`, or install individual packages like `typescript`/`vitest` unless a directory below explicitly says bootstrap failed and you truly need a single retry there.');
    lines.push('- Prefer the exact directory-specific commands listed below.');
    lines.push('- If a directory has no `tsconfig.json`, skip typecheck there.');
    lines.push('- If a directory has no test command, skip tests there.');
    lines.push('');

    if (projects.length === 0) {
      lines.push('- No Node/TypeScript project directories were detected. Inspect the repo manually.');
      return lines.join('\n');
    }

    for (const project of projects) {
      lines.push(`### ${project.relativePath}`);
      lines.push(`- Package: ${project.packageName}`);
      lines.push(`- Dependencies: ${this.describeInstallStatus(project)}`);
      lines.push(`- Typecheck: ${project.typecheckCommand ? `\`cd ${project.relativePath} && ${project.typecheckCommand}\`` : 'skip (no tsconfig)'}`);
      lines.push(`- Tests: ${project.testCommand ? `\`cd ${project.relativePath} && ${project.testCommand}\`` : 'skip (no test runner detected)'}`);
      if (project.installError) {
        lines.push(`- Bootstrap note: ${project.installError}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private describeInstallStatus(project: WorkspaceProject): string {
    if (project.installStatus === 'already_present') return 'already present';
    if (project.installStatus === 'installed') return `installed by worker using \`${project.installCommand}\``;
    if (project.installStatus === 'failed') return 'bootstrap failed';
    return 'not installed (not needed for validation)';
  }
}
