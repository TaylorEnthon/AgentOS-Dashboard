/**
 * Read-only Git service. NEVER executes write operations
 * (commit, checkout, reset, push, …) — only `log` / `rev-parse` / `show`.
 *
 * Used to project commits that happened during an Agent session's
 * time window. The output is a pure value (`GitSessionInfo`) — no
 * caching, no DB writes; the cost is one `git log` per session
 * request, which is acceptable for a local dashboard.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { GitCommitInfo, GitRepoInfo, GitSessionInfo } from '@agentos/shared';

const GIT_TIMEOUT_MS = 10_000;

/**
 * Walk up from `projectPath` to find the nearest ancestor that
 * contains `.git/`. Returns null if the path is not inside any
 * git repository. `.git` may be a directory (regular repo) or a file
 * (worktree / submodule).
 */
export async function findRepoRoot(projectPath: string): Promise<string | null> {
  let cur = path.resolve(projectPath);
  const root = path.parse(cur).root;
  for (;;) {
    const candidate = path.join(cur, '.git');
    try {
      const s = await fsp.stat(candidate);
      if (s.isDirectory() || s.isFile()) return cur;
    } catch {
      // not a repo at this level
    }
    if (cur === root) return null;
    cur = path.dirname(cur);
  }
}

/** Run a git command; resolve with trimmed stdout on exit 0, reject otherwise. */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`git ${args[0] ?? '?'} timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0] ?? '?'} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Like runGit but returns null on any failure (best-effort). */
async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return await runGit(args, cwd);
  } catch {
    return null;
  }
}

export async function currentBranch(repoRoot: string): Promise<string | undefined> {
  const out = await tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  return out?.trim() || undefined;
}

export async function currentCommit(repoRoot: string): Promise<string | undefined> {
  const out = await tryGit(['rev-parse', 'HEAD'], repoRoot);
  return out?.trim() || undefined;
}

/**
 * List commits in `[since, until]` time window, newest first.
 * Output is parsed from a single `git log` call. Per-commit `--stat`
 * is fetched in a second round-trip (kept small by `limit`).
 */
export async function commitsInRange(
  repoRoot: string,
  since: string,
  until: string,
  limit = 100,
): Promise<GitCommitInfo[]> {
  // Use ASCII unit separator (0x1f) between fields and ASCII record
  // separator (0x1e) between commits — never appears in commit msgs.
  const format = ['%H', '%h', '%aI', '%an', '%ae', '%s', '%b'].join('\x1f') + '\x1e';
  const out = await tryGit(
    [
      'log',
      '--no-merges',
      `--since=${since}`,
      `--until=${until}`,
      '-n', String(limit),
      `--format=${format}`,
      '--date-order',
    ],
    repoRoot,
  );
  if (!out) return [];

  const commits: GitCommitInfo[] = [];
  for (const record of out.split('\x1e')) {
    const rec = record.replace(/^\n+|\n+$/g, '');
    if (!rec) continue;
    const parts = rec.split('\x1f');
    if (parts.length < 7) continue;
    const [hash, shortHash, ts, author, email, subject, ...bodyParts] = parts;
    const body = bodyParts.join('\x1f').trim();
    commits.push({
      hash,
      shortHash,
      message: subject,
      body,
      author,
      authorEmail: email,
      timestamp: new Date(ts).toISOString(),
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
  }

  // Per-commit stat (single call per commit). We parse the summary
  // line which is always the LAST line of `git show --stat` output.
  for (const c of commits) {
    const stat = await tryGit(['show', '--stat', '--format=', c.hash], repoRoot);
    if (stat) {
      const summary = stat.trim().split('\n').pop() ?? '';
      // e.g. "1 file changed, 1 insertion(+), 1 deletion(-)"
      const f = summary.match(/(\d+) file/);
      const i = summary.match(/(\d+) insertion/);
      const d = summary.match(/(\d+) deletion/);
      if (f) c.filesChanged = Number(f[1]);
      if (i) c.insertions = Number(i[1]);
      if (d) c.deletions = Number(d[1]);
    }
  }
  return commits;
}

/**
 * One-stop helper: resolve the repo for a session, fetch branch +
 * current HEAD, and the commit list in the session's time window.
 */
export async function getGitSessionInfo(
  projectPath: string,
  startTime: string,
  endTime?: string,
): Promise<GitSessionInfo> {
  const root = await findRepoRoot(projectPath);
  if (!root) {
    return { repo: null, commits: [], reason: 'not a git repository' };
  }
  const until = endTime ?? new Date().toISOString();
  const [branch, headCommit, commits] = await Promise.all([
    currentBranch(root),
    currentCommit(root),
    commitsInRange(root, startTime, until),
  ]);
  const repo: GitRepoInfo = { root, branch, currentCommit: headCommit };
  return { repo, branch, commits };
}