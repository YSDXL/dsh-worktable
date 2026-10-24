/** 工作台窗口清单 buildWindowInventory 测试：测真实导出，不复制逻辑 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(HERE, '..', '01_content', 'package.json'))
const { build } = require('esbuild')

// buildWindowInventory 是 split.tsx 里的纯函数；react 由宿主提供，测试时 alias 到宿主真实路径
const HOST_NM = process.env.DSH_APP_NM || 'C:/AI/DSH Desktop Beta/resources/app/node_modules'
const OUT = join(HERE, '.tmp-inventory.mjs')
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
  try { Object.defineProperty(g, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', platform: 'Win32', clipboard: {} }, configurable: true }) } catch {}
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
if (typeof mod.buildWindowInventory !== 'function') {
  console.log('EXPORT KEYS: ' + Object.keys(mod).join(', '))
  console.log('FAIL: buildWindowInventory 未从 split.tsx 导出')
  process.exit(1)
}
const { buildWindowInventory, paneStatusSub } = mod

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); console.log('ok   ' + name); pass++ } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); fail++ } }

const tab = (id, content) => ({ id, title: 'T', content })
const pane = (id, tabs, title) => ({ id, title, tabs, active: 0, min: 200 })

t('spec 为 null：返回空数组', () => {
  assert.deepStrictEqual(buildWindowInventory(null), [])
})

t('单主行 + 浏览器：编号 1，含 hostname', () => {
  const spec = { id: 'p', title: 'p', main: [pane('m1', [tab('t1', { kind: 'builtin', type: 'browser', url: 'https://example.com/x' })])], chatWidth: { default: 320, min: 240, max: 600 } }
  const out = buildWindowInventory(spec)
  assert.strictEqual(out.length, 1)
  assert.match(out[0], /^窗口1：浏览器窗（example\.com）$/)
})

t('编号约定：左栏→顶行→主行，从 1 起', () => {
  const spec = {
    id: 'p', title: 'p',
    left: pane('l', [tab('t', { kind: 'builtin', type: 'explorer' })]),
    top: [pane('tp', [tab('t', { kind: 'builtin', type: 'terminal' })])],
    main: [pane('m1', [tab('t', { kind: 'builtin', type: 'anim', url: 'https://a.b/c' })]), pane('m2', [tab('t', { kind: 'file', path: 'D:/x/readme.md' })])],
    chatWidth: { default: 320, min: 240, max: 600 },
  }
  const out = buildWindowInventory(spec)
  assert.strictEqual(out.length, 4)
  assert.match(out[0], /^窗口1：资源管理器$/)
  assert.match(out[1], /^窗口2：终端窗$/)
  assert.match(out[2], /^窗口3：动画站（a\.b）$/)
  assert.match(out[3], /^窗口4：文件 readme\.md$/)
})

t('空窗格（无标签）报告为未指派', () => {
  const spec = { id: 'p', title: 'p', main: [pane('m1', [])], chatWidth: { default: 320, min: 240, max: 600 } }
  const out = buildWindowInventory(spec)
  assert.strictEqual(out.length, 1)
  assert.match(out[0], /空（未指派，显示选择器）$/)
})

t('多标签报告数量与当前序号', () => {
  const spec = { id: 'p', title: 'p', main: [pane('m1', [tab('a', { kind: 'builtin', type: 'browser' }), tab('b', { kind: 'builtin', type: 'terminal' })]), ], chatWidth: { default: 320, min: 240, max: 600 } }
  const out = buildWindowInventory(spec)
  assert.match(out[0], /（2 个标签，当前第 1 个）/)
})

t('窗格标题带书名号', () => {
  const spec = { id: 'p', title: 'p', main: [pane('m1', [tab('t', { kind: 'builtin', type: 'console' })], '监控')], chatWidth: { default: 320, min: 240, max: 600 } }
  const out = buildWindowInventory(spec)
  assert.match(out[0], /^窗口1「监控」：控制室$/)
})

t('iframe 网页与坏 URL 都不抛', () => {
  const spec = { id: 'p', title: 'p', main: [pane('m1', [tab('t', { kind: 'iframe', url: 'not a url' })])], chatWidth: { default: 320, min: 240, max: 600 } }
  const out = buildWindowInventory(spec)
  assert.strictEqual(out.length, 1)
  assert.match(out[0], /^窗口1：网页 /)  // 坏 URL 回落显示原文，不抛
  // 正常 URL 提取 hostname
  const ok = buildWindowInventory({ id: 'p', title: 'p', main: [pane('m1', [tab('t', { kind: 'iframe', url: 'https://a.b/c?d=1' })])], chatWidth: { default: 320, min: 240, max: 600 } })
  assert.match(ok[0], /^窗口1：网页 a\.b$/)
  // 空 URL
  const empty = buildWindowInventory({ id: 'p', title: 'p', main: [pane('m1', [tab('t', { kind: 'iframe', url: '' })])], chatWidth: { default: 320, min: 240, max: 600 } })
  assert.match(empty[0], /^窗口1：网页（无 URL）$/)
})

t('自定义任务窗被标出', () => {
  const spec = { id: 'p', title: 'p', main: [pane('m1', [tab('t', { kind: 'builtin', type: 'custom' })])], chatWidth: { default: 320, min: 240, max: 600 } }
  assert.match(buildWindowInventory(spec)[0], /自定义任务窗$/)
})

t('只有 left 时编号从 1 起（不跳号）', () => {
  const spec = { id: 'p', title: 'p', left: pane('l', [tab('t', { kind: 'builtin', type: 'terminal' })]), chatWidth: { default: 320, min: 240, max: 600 } }
  assert.match(buildWindowInventory(spec)[0], /^窗口1：/)
})

// ── paneStatusSub（窗格标题栏状态小字，借鉴 DSH-P「面板通用能力」§4）──
t('状态小字：null/undefined 返回空串', () => {
  assert.strictEqual(paneStatusSub(null), '')
  assert.strictEqual(paneStatusSub(undefined), '')
})

t('状态小字：内置窗各自的中文标签', () => {
  assert.strictEqual(paneStatusSub({ kind: 'builtin', type: 'terminal' }), '终端')
  assert.strictEqual(paneStatusSub({ kind: 'builtin', type: 'explorer' }), '资源管理器')
  assert.strictEqual(paneStatusSub({ kind: 'builtin', type: 'custom' }), '自定义任务')
  assert.strictEqual(paneStatusSub({ kind: 'builtin', type: 'console' }), '控制室')
})

t('状态小字：浏览器/动画站带 hostname，未导航时明确说明', () => {
  assert.strictEqual(paneStatusSub({ kind: 'builtin', type: 'browser', url: 'https://a.b/c' }), '浏览器 a.b')
  assert.strictEqual(paneStatusSub({ kind: 'builtin', type: 'browser' }), '浏览器（未导航）')
  assert.strictEqual(paneStatusSub({ kind: 'builtin', type: 'anim', url: 'https://x.y/z' }), '动画站 x.y')
})

t('状态小字：iframe 网页与文件预览', () => {
  assert.strictEqual(paneStatusSub({ kind: 'iframe', url: 'https://a.b/c' }), '网页 a.b')
  assert.strictEqual(paneStatusSub({ kind: 'file', path: 'D:/x/readme.md' }), '文件 readme.md')
})

t('状态小字：坏 URL 回落原文不抛', () => {
  assert.strictEqual(paneStatusSub({ kind: 'iframe', url: 'not a url' }), '网页 not a url')
  assert.strictEqual(paneStatusSub({ kind: 'iframe', url: '' }), '网页（无 URL）')
})

console.log(fail === 0 ? `ALL INVENTORY TESTS PASSED (${pass}/${pass})` : `FAILURES: ${fail}`)
process.exit(fail ? 1 : 0)
