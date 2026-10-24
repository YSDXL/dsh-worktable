/** 标签拖拽后吞 click 防护测试（借鉴 DSH-P「标签交互」①）。
 *  做法：把 split.tsx 里的 suppressTabClick / tabClickSuppressed 逻辑抽出来对齐验证，
 *  确保「拖拽后 500ms 内 click 被吞、窗口外放行、重复拖动会续期」。 */
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); console.log('ok   ' + name); pass++ } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); fail++ } }

/** 与 split.tsx 中实现同构（保持同步）：拖拽后 500ms 内吞 click */
const WINDOW_MS = 500
function makeSuppressor(now = () => Date.now()) {
  let until = 0
  return {
    suppress() { until = now() + WINDOW_MS },
    isSuppressed() { return now() < until },
  }
}

t('未拖动：click 放行', () => {
  const s = makeSuppressor()
  assert.strictEqual(s.isSuppressed(), false)
})

t('拖拽后立刻 click：被吞', () => {
  let clock = 1000
  const s = makeSuppressor(() => clock)
  s.suppress()
  assert.strictEqual(s.isSuppressed(), true, 't=1000 应在窗口内')
  clock = 1400
  assert.strictEqual(s.isSuppressed(), true, 't=1400（+400ms）仍在窗口内')
  clock = 1499
  assert.strictEqual(s.isSuppressed(), true, 't=1499 仍在窗口内')
})

t('窗口结束后 click 放行', () => {
  let clock = 1000
  const s = makeSuppressor(() => clock)
  s.suppress()
  clock = 1500
  assert.strictEqual(s.isSuppressed(), false, 't=1500 应已放行')
  clock = 5000
  assert.strictEqual(s.isSuppressed(), false)
})

t('连续拖动会续期窗口（不是叠加成 1000ms）', () => {
  let clock = 1000
  const s = makeSuppressor(() => clock)
  s.suppress()          // 窗口到 1500
  clock = 1400
  s.suppress()          // 续期到 1900
  clock = 1600
  assert.strictEqual(s.isSuppressed(), true, '续期后 t=1600 仍应被吞')
  clock = 1900
  assert.strictEqual(s.isSuppressed(), false, 't=1900 放行')
})

t('边界：恰好等于截止时刻算放行（与 now() < until 一致）', () => {
  let clock = 1000
  const s = makeSuppressor(() => clock)
  s.suppress()
  clock = 1500
  assert.strictEqual(s.isSuppressed(), false, 'now() === until 时不吞')
})

t('拖动后先拖拽再点击的顺序：点击必被吞', () => {
  let clock = 0
  const s = makeSuppressor(() => clock)
  // 模拟：dragstart → dragend → click
  s.suppress()
  clock = 120
  const swallowed = s.isSuppressed()
  assert.strictEqual(swallowed, true, '真实时序里 click 紧跟 dragend（<100ms），必须被吞')
})

console.log(fail === 0 ? `ALL TAB-CLICK-SUPPRESS TESTS PASSED (${pass}/${pass})` : `FAILURES: ${fail}`)
process.exit(fail ? 1 : 0)
