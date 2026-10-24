/** 常驻记忆渲染测试（对齐 BotHarness packages/core/src/memory/soul.ts）
 *  做法：先用 esbuild 把 src/memory.ts 打包成 ESM 到 04_test/.tmp-memory.mjs，
 *  再直接 import 测真实实现（不是在测试里复制一份逻辑自证）。 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert'

// esbuild 装在 01_content/devDependencies，从这里解析
const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(HERE, '..', '01_content', 'package.json'))
const { build } = require('esbuild')

const SRC = join(HERE, '..', '01_content', 'src', 'memory.ts')
const OUT = join(HERE, '.tmp-memory.mjs')

await build({ entryPoints: [SRC], outfile: OUT, bundle: true, format: 'esm', platform: 'node', logLevel: 'error' })

const m = await import(pathToFileURL(OUT).href)
rmSync(OUT, { force: true })

const { DEFAULT_STANDING_LIMITS, SOUL_FILE, CORE_MEMORY_FILE, memoryRootOf,
  renderStandingPrompt, standingPromptForCwd, standingUsage, findProjectRoot, isStandingLimit } = m

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++ }
  catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); fail++ }
}
const tmp = () => mkdtempSync(join(tmpdir(), 'wt-mem-'))
/** 造一个 git 项目根 + .dsh-worktable/memory */
const mkProject = (files = {}) => {
  const base = tmp()
  mkdirSync(join(base, '.git'), { recursive: true })
  const mem = memoryRootOf(base)
  mkdirSync(mem, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(mem, name), content, 'utf8')
  return { base, mem }
}

t('文件名与默认上限（与 BotHarness 一致）', () => {
  assert.strictEqual(SOUL_FILE, 'SOUL.md')
  assert.strictEqual(CORE_MEMORY_FILE, 'MEMORY.md')
  assert.deepStrictEqual(DEFAULT_STANDING_LIMITS, { soul: 5000, coreMemory: 3000 })
})

t('未超限：标题带百分比与用量，正文完整', () => {
  const { mem } = mkProject({ 'SOUL.md': '你好世界' })
  const out = renderStandingPrompt(mem)
  assert.match(out, /^## Soul \(SOUL\.md\) \[0% — 4\/5,000 chars\]\n\n你好世界$/)
})

t('正好等于上限：不截断、不追加提示', () => {
  const { mem } = mkProject({ 'SOUL.md': '12345' })
  const out = renderStandingPrompt(mem, { soul: 5, coreMemory: 5 })
  assert.strictEqual(out, '## Soul (SOUL.md) [100% — 5/5 chars]\n\n12345')
  assert.ok(!out.includes('Truncated'))
})

t('超限：截断到上限 + 追加说明，被截掉的内容不出现', () => {
  const { mem } = mkProject({ 'MEMORY.md': 'a'.repeat(10) + 'ZZZ' })
  const out = renderStandingPrompt(mem, { soul: 100, coreMemory: 5 })
  assert.ok(out.startsWith('## Core Memory (MEMORY.md) [260% — 13/5 chars]\n\n'))
  assert.ok(out.includes('aaaaa'))
  assert.ok(!out.includes('ZZZ'), '被截掉的内容不得出现')
  assert.ok(out.includes('[Truncated: MEMORY.md has 13 characters, over its 5-character limit.'))
  assert.ok(out.includes('Consolidate it below the limit; the full file is still on disk.]'))
})

t('字符数按 code point 计（中文/emoji 各算 1）', () => {
  const { mem } = mkProject({ 'SOUL.md': '你好😀' })
  const u = standingUsage(mem, { soul: 100, coreMemory: 100 })
  assert.strictEqual(u[0].chars, 3, '你好=2 + 😀=1')
})

t('两个文件都写入时：Soul 在前、空行分隔', () => {
  const { mem } = mkProject({ 'SOUL.md': 'A', 'MEMORY.md': 'B' })
  const out = renderStandingPrompt(mem, { soul: 100, coreMemory: 100 })
  assert.ok(out.indexOf('## Soul') < out.indexOf('## Core Memory'))
  assert.strictEqual(out, '## Soul (SOUL.md) [1% — 1/100 chars]\n\nA\n\n## Core Memory (MEMORY.md) [1% — 1/100 chars]\n\nB')
})

t('空/纯空白正文：该节不渲染', () => {
  const { mem } = mkProject({ 'SOUL.md': '   \n\n ' })
  assert.strictEqual(renderStandingPrompt(mem), '')
})

t('目录不存在：返回空串（section 会被宿主丢弃）', () => {
  assert.strictEqual(renderStandingPrompt(join(tmpdir(), 'wt-nope-' + Date.now())), '')
})

t('usage：报告角色/字符数/上限', () => {
  const { mem } = mkProject({ 'SOUL.md': '12345' })
  const u = standingUsage(mem, { soul: 10, coreMemory: 20 })
  assert.strictEqual(u.length, 1)
  assert.strictEqual(u[0].role, 'soul')
  assert.strictEqual(u[0].chars, 5)
  assert.strictEqual(u[0].limit, 10)
})

t('上限校验：500–50000 的整数', () => {
  for (const v of [500, 5000, 50000]) assert.ok(isStandingLimit(v), v + ' should pass')
  for (const v of [499, 50001, 1.5, '500', null, undefined]) assert.ok(!isStandingLimit(v), v + ' should fail')
})

t('项目根查找：向上找到含 .git 的目录', () => {
  const base = tmp()
  try {
    mkdirSync(join(base, '.git'), { recursive: true })
    const deep = join(base, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    assert.strictEqual(findProjectRoot(deep), base)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('项目根查找：无 .git 时回退起点目录', () => {
  const bare = tmp()
  try { assert.strictEqual(findProjectRoot(bare), bare) }
  finally { rmSync(bare, { recursive: true, force: true }) }
})

t('standingPromptForCwd：从会话 cwd 定位并渲染', () => {
  const { base } = mkProject({ 'SOUL.md': '人格内容' })
  const out = standingPromptForCwd(base, { soul: 100, coreMemory: 100 })
  assert.ok(out.includes('## Soul (SOUL.md)'))
  assert.ok(out.includes('人格内容'))
})

t('standingPromptForCwd：cwd 为空/无记忆时返回空串且不抛', () => {
  assert.strictEqual(standingPromptForCwd(undefined), '')
  assert.strictEqual(standingPromptForCwd(''), '')
  assert.strictEqual(standingPromptForCwd(join(tmpdir(), 'wt-empty-' + Date.now())), '')
})

t('记忆目录路径：<folder>/.dsh-worktable/memory', () => {
  assert.strictEqual(memoryRootOf('D:\\proj'), join('D:\\proj', '.dsh-worktable', 'memory'))
  assert.ok(memoryRootOf('/srv/app').endsWith('/memory') || memoryRootOf('/srv/app').endsWith('\\memory'))
})

console.log(fail === 0 ? `ALL MEMORY TESTS PASSED (${pass}/${pass})` : `FAILURES: ${fail}`)
process.exit(fail ? 1 : 0)
