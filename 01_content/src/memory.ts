/**
 * 项目常驻记忆（对齐 BotHarness packages/core/src/memory/soul.ts 的设计）
 *
 * 与 BotHarness 一致的三点：
 *   1. 真正注入 system prompt（ctx.systemPrompt.section），而不是指望宿主读 AGENTS.md
 *   2. 每个文件独立字符上限，超限截断并追加提示，磁盘文件不动
 *   3. 标题带 [百分比 — 已用/上限 chars]，方便一眼看出是否该整理
 *
 * 与 BotHarness 的差异（受 DSH 约束）：
 *   - 目录用项目文件夹下的 `.dsh-worktable/memory/`，不另建全局 Memory 仓库
 *   - 不做 Git 版本化与自动备份（BotHarness 那套需要独立仓库 + 提交身份）
 *   - 不做 front-matter 解析：纯 Markdown 正文即可，减少与用户已有文件的冲突
 *
 * 冻结语义：DSH 的 system prompt 在会话开始时装配，改动需新会话生效——与 BotHarness 一致。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve as pathResolve } from 'node:path'

/** 常驻文件名（固定两个，与 BotHarness 同名，便于互相迁移） */
export const SOUL_FILE = 'SOUL.md'
export const CORE_MEMORY_FILE = 'MEMORY.md'

/** 记忆目录（项目文件夹内，不污染项目根） */
export const MEMORY_DIR = '.dsh-worktable/memory'

export const DEFAULT_STANDING_LIMITS = { soul: 5000, coreMemory: 3000 } as const
export const MIN_STANDING_LIMIT = 500
export const MAX_STANDING_LIMIT = 50_000

export type StandingLimits = { soul: number; coreMemory: number }

export function isStandingLimit(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_STANDING_LIMIT && v <= MAX_STANDING_LIMIT
}

/** 字符数：按 code point 计（一个汉字/emoji 算 1），与 BotHarness 的 [...body].length 一致 */
function charCount(body: string): number {
  return [...body.trimEnd()].length
}

function readBody(root: string, file: string): string | undefined {
  const abs = join(root, file)
  try {
    if (!statSync(abs).isFile()) return undefined
    return readFileSync(abs, 'utf8')
  } catch {
    return undefined
  }
}

/** 记忆根目录 = <项目文件夹>/.dsh-worktable/memory */
export function memoryRootOf(projectFolder: string): string {
  return join(projectFolder, ...MEMORY_DIR.split('/'))
}

export interface StandingUsage {
  path: string
  role: 'soul' | 'coreMemory'
  chars: number
  limit: number
}

export function standingUsage(root: string, limits: StandingLimits = { ...DEFAULT_STANDING_LIMITS }): StandingUsage[] {
  const out: StandingUsage[] = []
  const soul = readBody(root, SOUL_FILE)
  if (soul !== undefined) out.push({ path: SOUL_FILE, role: 'soul', chars: charCount(soul), limit: limits.soul })
  const core = readBody(root, CORE_MEMORY_FILE)
  if (core !== undefined) out.push({ path: CORE_MEMORY_FILE, role: 'coreMemory', chars: charCount(core), limit: limits.coreMemory })
  return out
}

/** 渲染单节：标题带用量百分比；超限则截断并追加说明（与 BotHarness renderSection 同语义） */
function renderSection(title: string, file: string, body: string, limit: number): string {
  const characters = [...body.trimEnd()]
  const count = characters.length
  const percent = Math.round((count / limit) * 100)
  const header = `## ${title} (${file}) [${percent}% — ${count.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} chars]`
  if (count <= limit) return `${header}\n\n${characters.join('')}`
  return `${header}\n\n${characters.slice(0, limit).join('')}\n\n`
    + `[Truncated: ${file} has ${count.toLocaleString('en-US')} characters, over its ${limit.toLocaleString('en-US')}-character limit. `
    + `Consolidate it below the limit; the full file is still on disk.]`
}

/** 渲染完整常驻段落；两个文件都空/不存在时返回空串（section 会被自动丢弃） */
export function renderStandingPrompt(root: string, limits: StandingLimits = { ...DEFAULT_STANDING_LIMITS }): string {
  const sections: string[] = []
  const soul = readBody(root, SOUL_FILE)
  if (soul !== undefined && soul.trim().length > 0) sections.push(renderSection('Soul', SOUL_FILE, soul, limits.soul))
  const core = readBody(root, CORE_MEMORY_FILE)
  if (core !== undefined && core.trim().length > 0) sections.push(renderSection('Core Memory', CORE_MEMORY_FILE, core, limits.coreMemory))
  return sections.join('\n\n')
}

/** 从会话 cwd 定位项目根（含 .git 的目录）；找不到就用 cwd 本身 */
export function findProjectRoot(cwd: string): string {
  let dir = pathResolve(cwd)
  const start = dir
  for (let i = 0; i < 24; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

// ── Git 版本化（对齐 BotHarness memory/git.ts 的做法）──────────────────────────
// 记忆目录是独立的 Git 仓库，每次保存自动提交；可看历史、可恢复到某次提交。
// 身份兜底：仓库没配 user.name/user.email 时用 -c 注入，不碰用户全局 git 配置。

/** 记忆仓库提交身份（仅在仓库未配置时兜底使用） */
const MEM_IDENTITY = ['-c', 'user.name=dsh-worktable', '-c', 'user.email=worktable@dsh.local']

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function configured(root: string, key: string): boolean {
  try { return git(root, ['config', '--get', key]).trim().length > 0 } catch { return false }
}

/** 未配置的身份前缀（已配置则不加，尊重用户自己的 git 配置） */
function identityFallback(root: string): string[] {
  return [
    ...(configured(root, 'user.name') ? [] : ['-c', 'user.name=dsh-worktable']),
    ...(configured(root, 'user.email') ? [] : ['-c', 'user.email=worktable@dsh.local']),
  ]
}

/** 确保记忆目录是可用仓库：不存在则 init + .gitignore（忽略系统垃圾） */
export function ensureMemoryRepository(root: string): { ok: true } | { ok: false; code: string; message: string } {
  try {
    mkdirSync(root, { recursive: true })
    if (!existsSync(join(root, '.git'))) {
      git(root, ['init', '--quiet'])
      // 只跟踪记忆文件本身；编辑器/系统垃圾不入库
      writeFileSync(join(root, '.gitignore'), '.DS_Store\nThumbs.db\n*.tmp\n', 'utf8')
      git(root, ['add', '.gitignore'])
      git(root, [...MEM_IDENTITY, 'commit', '--no-gpg-sign', '--quiet', '-m', 'Initialize memory repository'])
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, code: 'git-unavailable', message: err instanceof Error ? err.message : String(err) }
  }
}

/** 原子写（临时文件 + rename）：避免保存中途崩溃留下半个文件 */
function atomicWrite(target: string, content: string): void {
  const tmp = target + '.tmp'
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, target)
}

/** 提交一次记忆变更；返回 commit sha（无变更时返回当前 HEAD） */
export function commitMemory(root: string, summary: string, source: 'human' | 'agent' = 'human'): string {
  const lines = [summary, '']
  if (source === 'human') lines.push('source=human')
  // 只 add 不存在的路径会让 git 报 pathspec 错误；-A 覆盖新增/修改/删除
  git(root, ['add', '-A'])
  git(root, [...identityFallback(root), 'commit', '--no-gpg-sign', '--quiet', '-m', lines.join('\n').trimEnd() + '\n', '--allow-empty'])
  try { return git(root, ['rev-parse', '--short', 'HEAD']).trim() } catch { return '' }
}

/** 保存记忆文件并提交（原子写 + git commit） */
export function writeMemoryFile(root: string, file: string, content: string, summary: string): string {
  ensureMemoryRepository(root)
  const target = join(root, file)
  mkdirSync(dirname(target), { recursive: true })
  atomicWrite(target, content.endsWith('\n') ? content : content + '\n')
  return commitMemory(root, summary, 'human')
}

/** 一条提交记录 */
export interface MemoryCommit {
  sha: string
  short: string
  message: string
  date: string
}

/** 最近提交列表（最新在前） */
export function memoryHistory(root: string, limit = 30): MemoryCommit[] {
  try {
    const out = git(root, ['log', '--pretty=format:%h%x1f%H%x1f%ad%x1f%s', '--date=short', '-' + String(Math.max(1, Math.min(100, limit)))])
    return out.split('\n').filter(Boolean).map((line) => {
      const [short, sha, date, ...rest] = line.split('\x1f')
      return { short, sha, date, message: rest.join('\x1f') }
    })
  } catch { return [] }
}

/** 当前工作区是否有未提交改动 */
export function memoryDirty(root: string): boolean {
  try { return git(root, ['status', '--porcelain']).trim().length > 0 } catch { return false }
}

/** 恢复到某次提交：先把未提交改动存成一个提交，再把文件切回目标提交后新增一个提交 */
export function restoreMemory(root: string, sha: string): { ok: boolean; error?: string } {
  try {
    ensureMemoryRepository(root)
    // 未提交改动先落一个提交，避免恢复时丢失
    if (memoryDirty(root)) commitMemory(root, 'Save changes before restore')
    git(root, ['checkout', '--quiet', sha, '--', '.'])
    git(root, [...identityFallback(root), 'commit', '--no-gpg-sign', '--quiet', '-m', `Restore memory to ${sha.slice(0, 7)}`, '--allow-empty'])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 会话 cwd → 常驻记忆渲染结果（空串 = 无记忆） */
export function standingPromptForCwd(cwd: string | undefined, limits?: StandingLimits): string {
  if (!cwd || typeof cwd !== 'string') return ''
  try {
    const root = findProjectRoot(cwd)
    return renderStandingPrompt(memoryRootOf(root), limits)
  } catch {
    return ''
  }
}
