/** 常驻记忆 Git 版本化测试：跑真实 git 命令，不 mock */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(HERE, '..', '01_content', 'package.json'))
const { build } = require('esbuild')
const OUT = join(HERE, '.tmp-memory.mjs')
await build({ entryPoints: [join(HERE, '..', '01_content', 'src', 'memory.ts')], outfile: OUT, bundle: true, format: 'esm', platform: 'node', logLevel: 'error' })
const m = await import(pathToFileURL(OUT).href)
rmSync(OUT, { force: true })

const { memoryRootOf, ensureMemoryRepository, writeMemoryFile, commitMemory, memoryHistory,
  memoryDirty, restoreMemory, renderStandingPrompt, findProjectRoot } = m

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); console.log('ok   ' + name); pass++ } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); fail++ } }

const gitCmd = (root, args) => {
  const { execFileSync } = require('node:child_process')
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

t('ensureMemoryRepository：创建 .git + .gitignore', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    const r = ensureMemoryRepository(mem)
    assert.deepStrictEqual(r, { ok: true })
    assert.ok(existsSync(join(mem, '.git')), '.git 应存在')
    assert.ok(existsSync(join(mem, '.gitignore')), '.gitignore 应存在')
    // 已有仓库时幂等
    assert.deepStrictEqual(ensureMemoryRepository(mem), { ok: true })
    const log = gitCmd(mem, ['log', '--pretty=format:%s']).trim()
    assert.strictEqual(log, 'Initialize memory repository')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('writeMemoryFile：写文件并返回 commit sha', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    const sha = writeMemoryFile(mem, 'SOUL.md', '# 灵魂\n测试内容', 'Update SOUL.md')
    assert.ok(/^[0-9a-f]{7,}$/.test(sha), '应返回短 sha，实际 ' + sha)
    assert.strictEqual(readFileSync(join(mem, 'SOUL.md'), 'utf8'), '# 灵魂\n测试内容\n')
    const msg = gitCmd(mem, ['log', '-1', '--pretty=format:%s'])
    assert.strictEqual(msg, 'Update SOUL.md')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('写入会补末尾换行（git 友好）', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    writeMemoryFile(mem, 'MEMORY.md', '无换行结尾', 'Update MEMORY.md')
    assert.ok(readFileSync(join(mem, 'MEMORY.md'), 'utf8').endsWith('\n'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('连续保存形成多条提交，最新在前', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    writeMemoryFile(mem, 'SOUL.md', 'v1', 'Update SOUL.md')
    writeMemoryFile(mem, 'SOUL.md', 'v2', 'Update SOUL.md')
    writeMemoryFile(mem, 'MEMORY.md', 'm1', 'Update MEMORY.md')
    const h = memoryHistory(mem)
    assert.ok(h.length >= 4, '含 init 至少 4 条，实际 ' + h.length)
    assert.strictEqual(h[0].message, 'Update MEMORY.md', '最新在前')
    assert.ok(h[0].short && h[0].sha && h[0].date)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('memoryDirty：保存后干净，外部改动后变脏', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    writeMemoryFile(mem, 'SOUL.md', 'v1', 'Update SOUL.md')
    assert.strictEqual(memoryDirty(mem), false, '保存后应干净')
    writeFileSync(join(mem, 'SOUL.md'), '外部改动\n', 'utf8')
    assert.strictEqual(memoryDirty(mem), true, '外部改文件后应脏')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('restoreMemory：恢复到旧版本，文件内容回到那时', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    writeMemoryFile(mem, 'SOUL.md', '第一版内容', 'Update SOUL.md')
    const firstSha = gitCmd(mem, ['rev-parse', 'HEAD']).trim()
    writeMemoryFile(mem, 'SOUL.md', '第二版内容', 'Update SOUL.md')
    assert.match(readFileSync(join(mem, 'SOUL.md'), 'utf8'), /第二版内容/)
    const out = restoreMemory(mem, firstSha)
    assert.strictEqual(out.ok, true, out.error ?? '')
    assert.match(readFileSync(join(mem, 'SOUL.md'), 'utf8'), /第一版内容/, '恢复后应回到第一版')
    const msgs = memoryHistory(mem, 10).map((c) => c.message)
    assert.ok(msgs.some((s) => s.includes('Restore memory to')), '应有恢复提交')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('restoreMemory：未提交改动会先被存成提交，不丢内容', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    writeMemoryFile(mem, 'SOUL.md', 'v1', 'Update SOUL.md')
    const target = gitCmd(mem, ['rev-parse', 'HEAD']).trim()
    writeMemoryFile(mem, 'SOUL.md', 'v2', 'Update SOUL.md')
    // 制造未提交改动
    writeFileSync(join(mem, 'MEMORY.md'), '未提交的草稿\n', 'utf8')
    assert.strictEqual(memoryDirty(mem), true)
    const out = restoreMemory(mem, target)
    assert.strictEqual(out.ok, true, out.error ?? '')
    const msgs = memoryHistory(mem, 10).map((c) => c.message)
    assert.ok(msgs.includes('Save changes before restore'), '未提交改动应先落提交')
    assert.strictEqual(memoryDirty(mem), false, '恢复后应干净')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('restoreMemory：坏 sha 返回 ok:false 且不抛', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    ensureMemoryRepository(mem)
    writeMemoryFile(mem, 'SOUL.md', 'v1', 'Update SOUL.md')
    const out = restoreMemory(mem, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    assert.strictEqual(out.ok, false)
    assert.ok(typeof out.error === 'string' && out.error.length > 0)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('记忆目录不污染项目根：.git 只在 .dsh-worktable/memory 下', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    gitCmd(base, ['init', '--quiet'])  // 项目本身是真 git 仓库
    writeFileSync(join(base, 'README.md'), 'project\n', 'utf8')
    gitCmd(base, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
    gitCmd(base, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--no-gpg-sign', '--quiet', '-m', 'project init'])
    const mem = memoryRootOf(base)
    writeMemoryFile(mem, 'SOUL.md', 'x', 'Update SOUL.md')
    assert.ok(existsSync(join(mem, '.git')))
    // 项目根的 git 历史不应被记忆写入污染
    const rootLog = gitCmd(base, ['log', '--pretty=format:%s'])
    assert.ok(!rootLog.includes('Update SOUL.md'), '记忆提交不得进项目仓库')
    assert.ok(rootLog.includes('project init'), '项目提交应仍在')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('renderStandingPrompt 与 git 互不干扰：读仍正常', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    writeMemoryFile(mem, 'SOUL.md', '人格', 'Update SOUL.md')
    const out = renderStandingPrompt(mem, { soul: 100, coreMemory: 100 })
    assert.ok(out.includes('## Soul (SOUL.md)'))
    assert.ok(out.includes('人格'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('memoryHistory 上限被夹紧（1–100）', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-git-'))
  try {
    const mem = memoryRootOf(base)
    ensureMemoryRepository(mem)
    assert.deepStrictEqual(memoryHistory(mem, 0), memoryHistory(mem, 1))
    assert.deepStrictEqual(memoryHistory(mem, 9999), memoryHistory(mem, 100))
    // 空仓库（无提交）不抛
    const bare = mkdtempSync(join(tmpdir(), 'wt-bare-'))
    try { assert.deepStrictEqual(memoryHistory(bare), []) }
    finally { rmSync(bare, { recursive: true, force: true }) }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

console.log(fail === 0 ? `ALL MEMORY GIT TESTS PASSED (${pass}/${pass})` : `FAILURES: ${fail}`)
process.exit(fail ? 1 : 0)
