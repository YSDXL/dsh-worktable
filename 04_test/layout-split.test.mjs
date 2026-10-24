/** 布局随时修改：splitPane / closePane 测试。
 *  直接驱动真实 splitStore（不 mock）：验证拆分/关闭不丢标签、边界被拒、持久化被调用。 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(HERE, '..', '01_content', 'package.json'))
const { build } = require('esbuild')
const HOST_NM = process.env.DSH_APP_NM || 'C:/AI/DSH Desktop Beta/resources/app/node_modules'
const OUT = join(HERE, '.tmp-split.mjs')
await build({
  entryPoints: [join(HERE, '..', '01_content', 'src', 'client', 'split.tsx')],
  outfile: OUT, bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
  jsx: 'automatic', logLevel: 'error',
  external: ['@deepseek-ai/*'],
  alias: { react: join(HOST_NM, 'react'), 'react-dom': join(HOST_NM, 'react-dom'), scheduler: join(HOST_NM, 'scheduler') },
  loader: { '.css': 'text' },
})

// xterm 等终端库需要浏览器全局；先注入最小桩再导入（Node 24 的 navigator 只读，用 defineProperty）
const g = globalThis
g.self = g
g.window = g
try { Object.defineProperty(g, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', platform: 'Win32', clipboard: {} }, configurable: true }) } catch {}
g.document = {
  createElement: () => ({ style: {}, appendChild() {}, remove() {}, setAttribute() {}, getContext: () => null }),
  addEventListener() {}, removeEventListener() {},
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
  head: { appendChild() {} }, documentElement: {},
  querySelector: () => null, querySelectorAll: () => [],
}
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
g.getComputedStyle = () => ({ fontSize: '12px', lineHeight: '18px', color: '#000' })
g.ResizeObserver = class { observe() {} disconnect() {} }
g.MutationObserver = class { observe() {} disconnect() {} }
g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
g.indexedDB = { open: () => ({ addEventListener() {} }) }
g.requestAnimationFrame = (cb) => setTimeout(cb, 0)
g.addEventListener = () => {}
g.removeEventListener = () => {}
g.location = { href: 'http://localhost/', hostname: 'localhost' }

const mod = await import(pathToFileURL(OUT).href)
rmSync(OUT, { force: true })
const { splitStore } = mod

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++ }
  catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); fail++ }
  finally { try { splitStore.close() } catch {} }  // 断言失败也要复位，避免同 id 早退污染后续用例
}

const CHAT = { default: 320, min: 240, max: 600 }
const tab = (id) => ({ id, title: 'T-' + id, content: { kind: 'builtin', type: 'terminal' } })
const pane = (id, tabs, title = '') => ({ id, title, min: 200, tabs, active: 0 })
/** 打开一个布局；spec 由调用方给出（不落盘也可跑，store 只写内存 + 回调） */
const open = (spec) => { splitStore.open(spec); return splitStore.spec }

t('splitPane：新增一个窗格，标签总数不变', () => {
  const spec = open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b'), tab('c')])], chatWidth: CHAT })
  assert.strictEqual(spec.main.length, 1)
  const idx = splitStore.splitPane('main', 0, 'right')
  assert.strictEqual(idx, 1, '新窗格下标应为 1')
  const s = splitStore.spec
  assert.strictEqual(s.main.length, 2, '应变成 2 个窗格')
  const all = s.main.flatMap((p) => p.tabs ?? [])
  assert.strictEqual(all.length, 3, '标签总数必须仍是 3（不复制不丢失）')
  assert.deepStrictEqual(all.map((x) => x.id).sort(), ['a', 'b', 'c'])
  splitStore.close()
})

t('splitPane：3 个标签对半 = 原窗 2 个、新窗 1 个', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b'), tab('c')])], chatWidth: CHAT })
  splitStore.splitPane('main', 0, 'right')
  const s = splitStore.spec
  assert.strictEqual(s.main[0].tabs.length, 2, '原窗应留 2 个')
  assert.strictEqual(s.main[1].tabs.length, 1, '新窗应得 1 个')
  assert.strictEqual(s.main[1].tabs[0].id, 'c', '搬过去的应是后一半')
  splitStore.close()
})

t('splitPane：单标签窗格拆出新空窗（不复制内容）', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('only')])], chatWidth: CHAT })
  splitStore.splitPane('main', 0, 'right')
  const s = splitStore.spec
  assert.strictEqual(s.main.length, 2)
  assert.strictEqual(s.main[0].tabs.length, 1, '原窗保留唯一标签')
  assert.strictEqual(s.main[1].tabs.length, 0, '新窗必须为空（不能复制）')
  splitStore.close()
})

t('splitPane：空窗格也能拆（两个都空）', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [])], chatWidth: CHAT })
  const idx = splitStore.splitPane('main', 0, 'right')
  assert.strictEqual(idx, 1)
  assert.strictEqual(splitStore.spec.main.length, 2)
  assert.strictEqual(splitStore.spec.main[1].tabs.length, 0)
  splitStore.close()
})

t('splitPane：新窗格 id 与原窗格不同（不串身份）', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b')])], chatWidth: CHAT })
  splitStore.splitPane('main', 0, 'right')
  const s = splitStore.spec
  assert.notStrictEqual(s.main[0].id, s.main[1].id, 'pane id 必须唯一（产物握手靠它校验归属）')
  splitStore.close()
})

t('splitPane：自定义标题加 (2) 后缀，默认「窗口N」标题留空由位置编号兜底', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b')], '终端')], chatWidth: CHAT })
  splitStore.splitPane('main', 0, 'right')
  let s = splitStore.spec
  assert.strictEqual(s.main[0].title, '终端', '原窗标题不变')
  assert.strictEqual(s.main[1].title, '终端 (2)', '自定义标题的新窗加 (2) 后缀')
  splitStore.close()
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b')], '窗口1')], chatWidth: CHAT })
  splitStore.splitPane('main', 0, 'right')
  s = splitStore.spec
  assert.strictEqual(s.main[1].title, '', '默认「窗口N」命名拆分出的新窗留空，由标题栏按位置自动编号（不出现「窗口1 2」）')
})

t('splitPane：自定义标题重名时继续加 (3)', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b')], '终端'), pane('m2', [tab('c')], '终端 (2)')], chatWidth: CHAT })
  splitStore.splitPane('main', 0, 'right')
  assert.strictEqual(splitStore.spec.main[1].title, '终端 (3)', '避开同行已占用名')
})

t('splitPane：left 行拒绝（整高单窗不支持）', () => {
  open({ id: 'p', title: 'P', left: pane('l', [tab('x')]), main: [pane('m1', [tab('a')])], chatWidth: CHAT })
  assert.strictEqual(splitStore.splitPane('left', 0, 'right'), -1)
  assert.strictEqual(splitStore.splitPane('left', 0, 'down'), -1)
  assert.strictEqual(splitStore.spec.main.length, 1, '布局不应被改动')
  splitStore.close()
})

t('splitPane：越界下标拒绝', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a')])], chatWidth: CHAT })
  assert.strictEqual(splitStore.splitPane('main', 5, 'right'), -1)
  assert.strictEqual(splitStore.spec.main.length, 1)
  splitStore.close()
})

t('splitPane：超过单行 6 个上限后拒绝', () => {
  const many = Array.from({ length: 6 }, (_, i) => pane('m' + i, [tab('t' + i)]))
  open({ id: 'p', title: 'P', main: many, chatWidth: CHAT })
  assert.strictEqual(splitStore.spec.main.length, 6)
  assert.strictEqual(splitStore.splitPane('main', 0, 'right'), -1, '第 7 个应被拒')
  assert.strictEqual(splitStore.spec.main.length, 6, '拒绝后布局不变')
  splitStore.close()
})

t('splitPane：top 行同样可拆', () => {
  open({ id: 'p', title: 'P', top: [pane('t1', [tab('a'), tab('b')])], main: [pane('m1', [tab('c')])], chatWidth: CHAT })
  const idx = splitStore.splitPane('top', 0, 'right')
  assert.strictEqual(idx, 1)
  assert.strictEqual(splitStore.spec.top.length, 2)
  splitStore.close()
})

t('closePane：标签搬去邻居，一个都不丢', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a')]), pane('m2', [tab('b')])], chatWidth: CHAT })
  const ok = splitStore.closePane('main', 0)
  assert.strictEqual(ok, true)
  const s = splitStore.spec
  assert.strictEqual(s.main.length, 1, '应变回 1 个窗格')
  const all = s.main.flatMap((p) => p.tabs ?? [])
  assert.deepStrictEqual(all.map((x) => x.id).sort(), ['a', 'b'], '两个标签都必须还在')
  splitStore.close()
})

t('closePane：关闭中间窗格，标签搬去右侧邻居', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a')]), pane('m2', [tab('b')]), pane('m3', [tab('c')])], chatWidth: CHAT })
  assert.strictEqual(splitStore.closePane('main', 1), true)
  const s = splitStore.spec
  assert.strictEqual(s.main.length, 2)
  const all = s.main.flatMap((p) => p.tabs ?? []).map((x) => x.id).sort()
  assert.deepStrictEqual(all, ['a', 'b', 'c'])
  // b 应落在原 m3（下标 1）
  assert.strictEqual(s.main[1].tabs.some((x) => x.id === 'b'), true)
  splitStore.close()
})

t('closePane：最后一个窗格拒绝（不许关成空台）', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a')])], chatWidth: CHAT })
  assert.strictEqual(splitStore.closePane('main', 0), false, '最后一个必须拒绝')
  assert.strictEqual(splitStore.spec.main.length, 1, '布局不变')
  splitStore.close()
})

t('closePane：left 行拒绝', () => {
  open({ id: 'p', title: 'P', left: pane('l', [tab('x')]), main: [pane('m1', [tab('a')])], chatWidth: CHAT })
  assert.strictEqual(splitStore.closePane('left', 0), false)
  splitStore.close()
})

t('拆分后再关闭 = 回到原状（可逆）', () => {
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b'), tab('c'), tab('d')])], chatWidth: CHAT })
  splitStore.splitPane('main', 0, 'right')
  assert.strictEqual(splitStore.spec.main.length, 2)
  splitStore.closePane('main', 1)   // 关掉拆出来的新窗
  const s = splitStore.spec
  assert.strictEqual(s.main.length, 1, '应回到单窗格')
  const all = s.main[0].tabs.map((x) => x.id).sort()
  assert.deepStrictEqual(all, ['a', 'b', 'c', 'd'], '四个标签都应回到唯一窗格')
  splitStore.close()
})

t('splitPane 触发 onSpecMutated（工作台侧栏能收到布局变更）', () => {
  let calls = 0
  splitStore.onSpecMutated = () => { calls++ }
  open({ id: 'p', title: 'P', main: [pane('m1', [tab('a'), tab('b')])], chatWidth: CHAT })
  const before = calls
  splitStore.splitPane('main', 0, 'right')
  assert.ok(calls > before, '应触发 onSpecMutated')
  splitStore.onSpecMutated = null
  splitStore.close()
})

console.log(fail === 0 ? `ALL SPLIT-PANE TESTS PASSED (${pass}/${pass})` : `FAILURES: ${fail}`)
process.exit(fail ? 1 : 0)
