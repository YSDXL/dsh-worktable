/**
 * terminal-fit 回归：终端窗必须真的把尺寸贴合窗格。
 *
 * 背景（教训）：split.tsx 曾用 `if (typeof term.fit === 'function')` 守一个
 * 根本不存在的方法 —— xterm@5.3.0 没有 term.fit，仓库也没装任何 addon，
 * 于是守卫恒假、fit 从不执行、cols/rows 永远停在连接时硬编码的 80×24，
 * resize 消息一次都没发出去。长行截断、TUI 花屏的根因就在这里。
 *
 * 本测试守源码契约（split.tsx / styles.ts），并在构建产物存在时顺带守产物契约。
 * 真正的行为验收仍是实跑用户路径：在终端窗里跑
 *   node -e "console.log(process.stdout.columns, process.stdout.rows)"
 * 应报出窗格真实尺寸。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const split = readFileSync(join(root, '01_content/src/client/split.tsx'), 'utf8')
const styles = readFileSync(join(root, '01_content/src/client/styles.ts'), 'utf8')
const bundlePath = join(root, '01_content/lib/client.js')

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message ?? e)) }
}

t('split.tsx 用 @xterm/addon-fit，而不是守一个不存在的方法', () => {
  assert.ok(/@xterm\/addon-fit/.test(split), '未 import @xterm/addon-fit')
  assert.ok(/new FitAddon\(\)/.test(split), '未实例化 FitAddon')
  assert.ok(!/typeof\s+term\.fit\s*===\s*'function'/.test(split), '仍在使用恒假的 typeof term.fit 守卫')
})

t('split.tsx 用维护线的 @xterm/xterm，不再用老包 xterm', () => {
  assert.ok(/from '@xterm\/xterm'/.test(split), '未从 @xterm/xterm 导入 Terminal')
  assert.ok(!/from 'xterm'/.test(split), '仍从老包 xterm 导入')
})

t('终端尺寸不再硬编码 80×24，且真的调用 fit', () => {
  assert.ok(!/cols=80&rows=24/.test(split), 'WS 连接仍硬编码 cols=80&rows=24')
  assert.ok(/fit\.fit\(\)/.test(split), '未见 fit.fit() 调用')
})

t('styles.ts 的终端样式来自 @xterm/xterm', () => {
  assert.ok(/from '@xterm\/xterm\/css\/xterm\.css'/.test(styles), '样式未指向 @xterm/xterm')
  assert.ok(!/from 'xterm\/css/.test(styles), '样式仍指向老包 xterm')
})

t('终端窗自带剪贴板通道（xterm 不碰系统剪贴板，必须显式接线）', () => {
  assert.ok(/attachCustomKeyEventHandler/.test(split), '未接 Ctrl+Shift+C/V 自定义键处理')
  assert.ok(/navigator\.clipboard\.writeText/.test(split), '复制路径未写系统剪贴板')
  assert.ok(/term\.paste\(/.test(split), '粘贴路径未调用 term.paste')
})

t('终端窗内的右键就地掐断，不在终端里弹窗格菜单', () => {
  assert.ok(/'contextmenu'/.test(split), '未在终端宿主上监听 contextmenu')
  const m = split.match(/const onCtx = \(e: MouseEvent\) => \{[\s\S]{0,240}?\n {4}\}/)
  assert.ok(m, '未找到 onCtx 处理器')
  assert.ok(/e\.preventDefault\(\)/.test(m[0]), 'onCtx 未 preventDefault')
  assert.ok(/e\.stopPropagation\(\)/.test(m[0]), 'onCtx 未 stopPropagation（会漏给窗格菜单）')
})

t('构建产物 lib/client.js 与源码契约一致（存在时）', () => {
  if (!existsSync(bundlePath)) {
    console.log('       (lib/client.js 不存在，跳过产物断言 —— 先 cd 01_content && npm run build)')
    return
  }
  const b = readFileSync(bundlePath, 'utf8')
  assert.ok(/loadAddon/.test(b), '产物里没有 loadAddon')
  assert.ok(/attachCustomKeyEventHandler/.test(b), '产物里没有剪贴板键处理')
  assert.ok(!/cols=80&rows=24/.test(b), '产物里仍是硬编码 cols=80&rows=24')
})

console.log('terminal-fit: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)