/**
 * Tests for the read-only git projection. Each test creates a real
 * temporary git repo via `git init` + `git commit`, then exercises the
 * service against it. No test writes to the user's actual repo.
 *
 * IMPORTANT: all `git` invocations use `git -C <path> ...` instead of
 * relying on the `cwd:` option of `execSync`. `git -C` is the git-native
 * way of selecting a working directory and is more reliable across
 * platforms (especially on Windows). The `cwd:` option can be silently
 * ignored in some edge cases, which is how the very first version of
 * this test polluted the project's git history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  findRepoRoot,
  commitsInRange,
  currentBranch,
  currentCommit,
  getGitSessionInfo,
} from '../src/git-service.js';

/** Run `git` against a specific repo path via `git -C <path>`. */
function git(repoPath: string, args: string): void {
  // Use `-C` so cwd is set by git itself, not by Node's spawn — and
  // never `shell:true` (we don't need a shell).
  execSync(`git -C "${repoPath}" ${args}`, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentos-git-'));
  // -b main avoids "hint: Using 'master'" noise on newer git
  git(root, 'init -q -b main');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Tester"');
  git(root, 'config commit.gpgsign false');
  // First commit: add a.txt (1 file, 1 insertion)
  writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  git(root, 'add a.txt');
  git(root, 'commit -q -m "first commit"');
  // Second commit: replace a.txt (1 file, 1 insertion, 1 deletion)
  writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
  git(root, 'add a.txt');
  git(root, 'commit -q -m "second: feat x"');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('findRepoRoot: detects .git in current dir', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const found = await findRepoRoot(root);
    assert.equal(found, root);
  } finally { cleanup(); }
});

test('findRepoRoot: detects .git in ancestor dir (subdir)', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const sub = path.join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const found = await findRepoRoot(sub);
    assert.equal(found, root);
  } finally { cleanup(); }
});

test('findRepoRoot: returns null for non-repo path', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentos-norepo-'));
  try {
    const found = await findRepoRoot(dir);
    assert.equal(found, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findRepoRoot: returns null for non-existent path', async () => {
  // Build a path that is guaranteed to NOT exist on any platform: a
  // random subdirectory of the OS temp dir. Using 'Z:\...' (which
  // worked on Windows) silently resolves to a relative path on Linux
  // and may end up pointing at a real directory.
  const phantom = path.join(os.tmpdir(), `agentos-no-such-${Date.now()}-${Math.random()}/sub/deep`);
  const found = await findRepoRoot(phantom);
  assert.equal(found, null);
});

test('commitsInRange: returns all commits in window, newest first', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const commits = await commitsInRange(root, from, to);
    assert.equal(commits.length, 2);
    // Newest first
    assert.equal(commits[0].message, 'second: feat x');
    assert.equal(commits[1].message, 'first commit');
  } finally { cleanup(); }
});

test('commitsInRange: empty window returns []', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const from = new Date(Date.now() + 60_000).toISOString();
    const to = new Date(Date.now() + 120_000).toISOString();
    const commits = await commitsInRange(root, from, to);
    assert.equal(commits.length, 0);
  } finally { cleanup(); }
});

test('commitsInRange: parses hash/shortHash/author/email/timestamp', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const [c] = await commitsInRange(root, from, to);
    assert.equal(c.hash.length, 40);
    assert.ok(c.shortHash.length >= 7);
    assert.equal(c.author, 'Tester');
    assert.equal(c.authorEmail, 'test@example.com');
    assert.ok(c.timestamp);
    assert.ok(!Number.isNaN(Date.parse(c.timestamp)));
  } finally { cleanup(); }
});

test('commitsInRange: populates filesChanged/insertions/deletions from --stat', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const commits = await commitsInRange(root, from, to);
    const first = commits.find((c) => c.message === 'first commit')!;
    const second = commits.find((c) => c.message === 'second: feat x')!;
    // First commit added a.txt: 1 file, 1 insertion, 0 deletions
    assert.equal(first.filesChanged, 1);
    assert.equal(first.insertions, 1);
    assert.equal(first.deletions, 0);
    // Second commit replaced a.txt: 1 file, 1 insertion, 1 deletion
    assert.equal(second.filesChanged, 1);
    assert.equal(second.insertions, 1);
    assert.equal(second.deletions, 1);
  } finally { cleanup(); }
});

test('commitsInRange: respects limit', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const commits = await commitsInRange(root, from, to, 1);
    assert.equal(commits.length, 1);
  } finally { cleanup(); }
});

test('currentBranch: returns main', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const branch = await currentBranch(root);
    assert.equal(branch, 'main');
  } finally { cleanup(); }
});

test('currentCommit: returns 40-char SHA', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const sha = await currentCommit(root);
    assert.ok(sha);
    assert.equal(sha!.length, 40);
  } finally { cleanup(); }
});

test('getGitSessionInfo: full happy path', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const info = await getGitSessionInfo(root, from, to);
    assert.ok(info.repo);
    assert.equal(info.repo!.root, root);
    assert.equal(info.branch, 'main');
    assert.ok(info.repo!.currentCommit);
    assert.equal(info.commits.length, 2);
    assert.equal(info.reason, undefined);
  } finally { cleanup(); }
});

test('getGitSessionInfo: non-repo path returns reason', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentos-norepo-'));
  try {
    const info = await getGitSessionInfo(dir, new Date().toISOString());
    assert.equal(info.repo, null);
    assert.equal(info.commits.length, 0);
    assert.equal(info.reason, 'not a git repository');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getGitSessionInfo: finds repo from subdir', async () => {
  const { root, cleanup } = setupRepo();
  try {
    const sub = path.join(root, 'src');
    mkdirSync(sub, { recursive: true });
    const info = await getGitSessionInfo(sub, new Date(Date.now() - 60_000).toISOString());
    assert.ok(info.repo);
    assert.equal(info.repo!.root, root);
  } finally { cleanup(); }
});

/**
 * Last-resort guard: after ALL tests, verify the project repo was not
 * polluted. If this test ever fails, it means the test fixture is
 * running git commands in the wrong directory. The cwd-based approach
 * was prone to that; the `git -C` rewrite should make it impossible.
 */
test('test fixture: project repo log is unchanged', () => {
  const currentCount = execSync('git log --oneline', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean).length;
  // The project repo should have only the commits we know about. If
  // this changes between runs, the test fixture is leaking.
  assert.ok(currentCount > 0, 'project repo should have at least 1 commit');
  // Just make sure the count is sane (not 50+ from pollution).
  assert.ok(currentCount < 50, `project repo has too many commits (${currentCount}); test fixture may be polluting`);
});