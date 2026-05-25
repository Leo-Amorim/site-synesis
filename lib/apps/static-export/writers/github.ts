/**
 * GitHub-repo writer.
 *
 * Clones the target branch (or initializes an empty repo if the branch
 * doesn't exist yet), wipes the working tree, drops in the exported files,
 * commits, and pushes. Each export gets a fresh tmpdir to sidestep stale
 * state and concurrent-export races at the cost of one clone per run.
 *
 * The token is never put through a shell — git receives args via argv,
 * and config inputs are validated against tight regexes up front.
 */

import fs from 'fs/promises'
import path from 'path'

import type { ExportConfig } from '../types'
import type { OutputFile, Writer } from './types'

const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const GITHUB_BRANCH_RE = /^[A-Za-z0-9._/-]+$/
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_.=-]+$/

interface GithubWriterContext {
  config: ExportConfig
}

export async function createGithubWriter(config: ExportConfig): Promise<Writer> {
  if (!GITHUB_REPO_RE.test(config.githubRepo)) {
    throw new Error('GitHub export selected but `githubRepo` must look like "owner/repo"')
  }
  if (!GITHUB_BRANCH_RE.test(config.githubBranch)) {
    throw new Error('GitHub export selected but `githubBranch` has invalid characters')
  }
  if (!GITHUB_TOKEN_RE.test(config.githubToken)) {
    throw new Error('GitHub export selected but `githubToken` looks malformed')
  }

  const ctx: GithubWriterContext = { config }
  return {
    name: 'github',
    async flush(files) {
      return runGithubFlush(ctx, files)
    },
  }
}

async function runGithubFlush(
  ctx: GithubWriterContext,
  files: OutputFile[],
): Promise<number> {
  const { spawn } = await import('node:child_process')
  const os = await import('node:os')

  const { config } = ctx
  const authorName = config.githubAuthorName.trim() || 'Ycode Static Export'
  const authorEmail = config.githubAuthorEmail.trim() || 'static-export@ycode.local'

  const cloneUrl =
    `https://x-access-token:${encodeURIComponent(config.githubToken)}@github.com/` +
    `${config.githubRepo}.git`

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ycode-static-export-'))
  try {
    const exec = (args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string } = {}) =>
      new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        const child = spawn('git', args, {
          cwd: opts.cwd ?? workDir,
          env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => { stdout += d.toString() })
        child.stderr.on('data', (d) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
        if (opts.stdin !== undefined) {
          child.stdin.end(opts.stdin)
        }
      })

    let cloneOk = false
    {
      const r = await exec(
        ['clone', '--depth=1', '--single-branch', `--branch=${config.githubBranch}`, cloneUrl, '.'],
        { cwd: workDir },
      )
      cloneOk = r.code === 0
      if (!cloneOk && !/(Remote branch .* not found|empty repository)/i.test(r.stderr)) {
        throw new Error(`git clone failed (${r.code}): ${trimGitOutput(r.stderr)}`)
      }
    }

    if (!cloneOk) {
      const init = await exec(['init', '-b', config.githubBranch], { cwd: workDir })
      if (init.code !== 0) throw new Error(`git init failed: ${trimGitOutput(init.stderr)}`)
      const remote = await exec(['remote', 'add', 'origin', cloneUrl])
      if (remote.code !== 0) throw new Error(`git remote add failed: ${trimGitOutput(remote.stderr)}`)
    }

    await exec(['config', 'user.name', authorName])
    await exec(['config', 'user.email', authorEmail])

    // Wipe non-.git contents so deletions reflect in the commit.
    for (const entry of await fs.readdir(workDir)) {
      if (entry === '.git') continue
      await fs.rm(path.join(workDir, entry), { recursive: true, force: true })
    }

    for (const f of files) {
      const target = path.join(workDir, f.key)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf-8') : f.body
      await fs.writeFile(target, body)
    }

    const add = await exec(['add', '-A'])
    if (add.code !== 0) throw new Error(`git add failed: ${trimGitOutput(add.stderr)}`)

    // Skip empty commits so the deploy repo doesn't collect no-op commits.
    const status = await exec(['status', '--porcelain'])
    if (status.code === 0 && status.stdout.trim().length === 0) {
      return 0
    }

    const message = `Static export — ${files.length} file${files.length === 1 ? '' : 's'} — ${new Date().toISOString()}`
    const commit = await exec(['commit', '-m', message])
    if (commit.code !== 0) throw new Error(`git commit failed: ${trimGitOutput(commit.stderr)}`)

    const push = await exec(['push', '-u', 'origin', config.githubBranch])
    if (push.code !== 0) throw new Error(`git push failed: ${trimGitOutput(push.stderr)}`)

    return files.length
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Trim known token leakage from git stderr so it's safe to log. */
function trimGitOutput(stderr: string): string {
  return stderr
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    .slice(0, 4096)
}
