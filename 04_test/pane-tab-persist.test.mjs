/**
 * pane-tab-persist 回归：标签页必须常驻，切换标签不能卸载 iframe。
 *
 * 背景（教训）：PaneBody 此前只渲染 `tabs[active]`，切标签 = 卸载旧的 iframe、
 * 挂载新的 —— 卸载 iframe 就是整页重载。对一个几百 KB JS 的站点，每次切回来
 * 都要从头加载，观感就是「又卡」。现在改成渲染全部标签、用 display 切显隐。
 *
 * 本测试守源码契约（防有人「顺手简化」回单标签渲染，静默把重载带回来）。
 * 真正的行为验收仍是实跑：在浏览器窗里开两个标签、来回切，
 * 页面不应重新加载（滚动位置与页面内状态保留）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const split = readFileSync(join(root, '01_content/src/client/split.tsx'), 'utf8')

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message ?? e)) }
}

t('不再只渲染 active 标签（那样切换就是卸载重载）', () => {
  assert.ok(
    !/<PaneTabBody tab=\{tabs\[active\]\}/.test(split),
    'PaneBody 又只渲染 tabs[active] 了 —— 切标签会整页重载'
  )
})

t('渲染全部标签，并用 display 切显隐', () => {
  assert.ok(/\{tabs\.map\(\(t, i\) => \(/.test(split), '未按 tabs.map 渲染全部标签')
  assert.ok(/className="dsh-wt_tabBody"/.test(split), '缺少常驻标签的容器 .dsh-wt_tabBody')
  assert.ok(
    /display: i === active \? 'flex' : 'none'/.test(split),
    '非 active 标签没有用 display:none 隐藏（会全部叠在一起）'
  )
})

console.log('pane-tab-persist: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)