import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RepoManager } from './repo-manager.js';

// We exercise mergePr end-to-end against mocked execShell + fetch instead of
// testing the private helpers directly. That way the test stays close to the
// real call graph and catches regressions in either layer.

interface ExecResult { stdout: string; stderr: string; exitCode: number }

function makeRepoManager() {
  const repo = new RepoManager();
  // Stubbed shell — drives the gh pr merge result.
  const execShellMock = vi.fn<(cwd: string, cmd: string) => Promise<ExecResult>>();
  // Stubbed git — only used by getOwnerRepo to derive owner/repo from origin url.
  const execGitMock = vi.fn<(cwd: string, args: string[]) => Promise<string>>();
  // Cast through unknown to swap the private members on the instance.
  (repo as unknown as { execShell: typeof execShellMock }).execShell = execShellMock;
  (repo as unknown as { execGit: typeof execGitMock }).execGit = execGitMock;
  return { repo, execShellMock, execGitMock };
}

describe('RepoManager.mergePr', () => {
  const ORIGINAL_TOKEN = process.env.GH_TOKEN;

  beforeEach(() => {
    process.env.GH_TOKEN = 'test-token';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.GH_TOKEN = ORIGINAL_TOKEN;
  });

  it('merges on the first attempt and then deletes the branch via REST API', async () => {
    const { repo, execShellMock, execGitMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    execGitMock.mockResolvedValueOnce('https://github.com/maismilhas-br/maismilhas.b2b.portal.git');

    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    await repo.mergePr('/tmp/repo', 'feat/foo');

    expect(execShellMock).toHaveBeenCalledTimes(1);
    expect(execShellMock).toHaveBeenCalledWith('/tmp/repo', expect.stringContaining('gh pr merge feat/foo --squash --delete-branch'));
    expect(execShellMock.mock.calls[0][1]).not.toContain('--admin');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/maismilhas-br/maismilhas.b2b.portal/git/refs/heads/feat%2Ffoo');
    expect(init.method).toBe('DELETE');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('token test-token');
  });

  it('retries with --admin when branch protection blocks the merge', async () => {
    const { repo, execShellMock, execGitMock } = makeRepoManager();
    execShellMock
      .mockResolvedValueOnce({ stdout: '', stderr: 'GH013: Required status check "ci" is expected.', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    execGitMock.mockResolvedValueOnce('git@github.com:maismilhas-br/maismilhas.b2b.portal.git');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await repo.mergePr('/tmp/repo', 'feat/foo');

    expect(execShellMock).toHaveBeenCalledTimes(2);
    expect(execShellMock.mock.calls[1][1]).toContain('--admin');
  });

  it('throws if the second --admin attempt also fails', async () => {
    const { repo, execShellMock } = makeRepoManager();
    execShellMock
      .mockResolvedValueOnce({ stdout: '', stderr: 'required status check pending', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'token lacks admin permission', exitCode: 1 });

    await expect(repo.mergePr('/tmp/repo', 'feat/foo')).rejects.toThrow(/gh pr merge failed/);
    expect(execShellMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry with --admin for unrelated errors (e.g. dirty working tree)', async () => {
    const { repo, execShellMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({
      stdout: '',
      stderr: 'Pull request is not open: closed',
      exitCode: 1,
    });

    await expect(repo.mergePr('/tmp/repo', 'feat/foo')).rejects.toThrow(/closed/);
    expect(execShellMock).toHaveBeenCalledTimes(1);
  });

  it('treats HTTP 404 from branch delete API as already-gone (no throw)', async () => {
    const { repo, execShellMock, execGitMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    execGitMock.mockResolvedValueOnce('https://github.com/maismilhas-br/foo.git');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })));

    await expect(repo.mergePr('/tmp/repo', 'feat/foo')).resolves.toBeUndefined();
  });

  it('does not throw when branch delete returns 403 — stale branch is logged, merge stays green', async () => {
    const { repo, execShellMock, execGitMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    execGitMock.mockResolvedValueOnce('https://github.com/maismilhas-br/foo.git');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })));

    await expect(repo.mergePr('/tmp/repo', 'feat/foo')).resolves.toBeUndefined();
    // Warn (not error) so downstream stages still run; surfacing the actual HTTP status is what matters.
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/HTTP 403/));
  });

  it('skips API delete when GH_TOKEN is missing (warns once, merge still succeeds)', async () => {
    delete process.env.GH_TOKEN;
    const { repo, execShellMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await repo.mergePr('/tmp/repo', 'feat/foo');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('GH_TOKEN not set'));
  });

  it('skips API delete when origin remote does not look like GitHub', async () => {
    const { repo, execShellMock, execGitMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    execGitMock.mockResolvedValueOnce('https://gitlab.com/foo/bar.git');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await repo.mergePr('/tmp/repo', 'feat/foo');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('parse owner/repo'));
  });

  it('handles SSH-style origin URLs (git@github.com:owner/repo.git)', async () => {
    const { repo, execShellMock, execGitMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    execGitMock.mockResolvedValueOnce('git@github.com:maismilhas-br/maismilhas.nexus.app.git');
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    await repo.mergePr('/tmp/repo', 'feat/foo');

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain('/repos/maismilhas-br/maismilhas.nexus.app/');
  });

  it('encodes branch names with slashes safely in the API URL', async () => {
    const { repo, execShellMock, execGitMock } = makeRepoManager();
    execShellMock.mockResolvedValueOnce({ stdout: 'merged', stderr: '', exitCode: 0 });
    execGitMock.mockResolvedValueOnce('https://github.com/maismilhas-br/foo.git');
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    await repo.mergePr('/tmp/repo', 'feat/some-thing/v2');

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain('/git/refs/heads/feat%2Fsome-thing%2Fv2');
  });
});
