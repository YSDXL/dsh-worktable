/** 记日记路由的 git 序列验证：在临时目录造一个 bare origin + 工作克隆，
 *  按 /api/worktable/diary handler 里同一串动作跑一遍，断言结果。
 *  不碰真实 knowledge 仓、不推真实远端。 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const g = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); console.log('ok   ' + name); pass++ } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); fail++ } }

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'wt-diary-'))
  const origin = join(base, 'origin.git')
  const work = join(base, 'work')
  mkdirSync(origin, { recursive: true })
  g(base, ['init', '--bare', '-q', '--initial-branch=main', origin])
  g(base, ['clone', '-q', origin, work])
  // 初始提交 + 一个已存在的今天日记（验证追加而不是覆盖）
  mkdirSync(join(work, 'diary'), { recursive: true })
  writeFileSync(join(work, 'diary', '2026-10-24.md'), '# 2026-10-24\n\n## 09:00 zcode\n\n- 早上的条目\n', 'utf8')
  g(work, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  g(work, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  g(work, ['push', '-q', 'origin', 'HEAD'])
  return { base, work }
}

/** 与 src/index.ts diary handler 相同的动作序列 */
function runDiary(work, { who, text, day, hhmm }) {
  const rel = 'diary/' + day + '.md'
  const file = join(work, ...rel.split('/'))
  try { g(work, ['pull', '--rebase', '--autostash']) } catch {}
  let old = ''
  try { old = readFileSync(file, 'utf8') } catch { old = '# ' + day + '\n' }
  const entry = '\n## ' + hhmm + ' ' + who + '\n\n' + text.split('\n').map((l) => '- ' + l).join('\n') + '\n'
  writeFileSync(file, (old.endsWith('\n') ? old : old + '\n') + entry, 'utf8')
  g(work, ['add', '--', rel])
  g(work, ['-c', 'user.name=dsh', '-c', 'user.email=dsh@fleet.local', 'commit', '--no-gpg-sign', '-q', '-m', '日记 ' + day + ' ' + who])
  let pushed = false
  try { g(work, ['push', '--quiet', 'origin', 'HEAD']); pushed = true } catch {}
  return { file, rel, pushed }
}

t('追加而非覆盖：原有内容保留、新条目在末尾', () => {
  const { base, work } = fixture()
  try {
    const r = runDiary(work, { who: 'dsh', text: '接入知识库\nSSH 配通', day: '2026-10-24', hhmm: '15:40' })
    assert.strictEqual(r.pushed, true, '应推送成功')
    const body = readFileSync(r.file, 'utf8')
    assert.ok(body.includes('早上的条目'), '旧条目必须在')
    assert.ok(body.includes('## 15:40 dsh'), '新条目标题带时间署名')
    assert.ok(body.includes('- 接入知识库') && body.includes('- SSH 配通'), '每行前加列表符号')
    assert.ok(body.indexOf('早上的条目') < body.indexOf('15:40 dsh'), '追加顺序：旧在前新在后')
    // 远端真的收到了
    const remote = g(work, ['show', 'origin/main:diary/2026-10-24.md'])
    assert.ok(remote.includes('15:40 dsh'), 'origin 上应可见同一条目')
    const msg = g(work, ['log', '-1', '--pretty=%an <%ae>%x1f%s']).trim()
    assert.ok(msg.startsWith('dsh <dsh@fleet.local>'), '提交身份应为插件署名：' + msg)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('日记文件不存在：自动新建带日期标题', () => {
  const { base, work } = fixture()
  try {
    const r = runDiary(work, { who: 'hermes', text: '夜里巡检', day: '2026-10-25', hhmm: '23:30' })
    assert.ok(existsSync(r.file))
    const body = readFileSync(r.file, 'utf8')
    assert.ok(body.startsWith('# 2026-10-25'), '新文件应以日期标题开头')
    assert.ok(body.includes('## 23:30 hermes'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('连续两条不互相吞掉', () => {
  const { base, work } = fixture()
  try {
    runDiary(work, { who: 'dsh', text: '第一条', day: '2026-10-24', hhmm: '15:41' })
    const r2 = runDiary(work, { who: 'zcode', text: '第二条', day: '2026-10-24', hhmm: '15:42' })
    const body = readFileSync(r2.file, 'utf8')
    assert.ok(body.includes('## 15:41 dsh') && body.includes('## 15:42 zcode'), '两条都应在')
    assert.strictEqual(r2.pushed, true, '第二条也应推送成功')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('离线/无 origin：保留本地提交不抛（pushed=false）', () => {
  const { base, work } = fixture()
  try {
    g(work, ['remote', 'remove', 'origin'])
    const r = runDiary(work, { who: 'dsh', text: '断网也能记', day: '2026-10-24', hhmm: '15:43' })
    assert.strictEqual(r.pushed, false, '推送失败应回报 pushed=false')
    const head = g(work, ['log', '-1', '--pretty=%s']).trim()
    assert.ok(head.includes('日记 2026-10-24 dsh'), '本地提交必须仍在：' + head)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

t('路径不逃逸：日记只落在仓库 diary/ 内', () => {
  const { base, work } = fixture()
  try {
    const r = runDiary(work, { who: 'dsh', text: 'x', day: '2026-10-24', hhmm: '15:44' })
    assert.ok(resolve(r.file).startsWith(resolve(work) + sep), '写入路径必须在仓库内')
    assert.strictEqual(r.rel, 'diary/2026-10-24.md')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

console.log(fail === 0 ? `ALL DIARY ROUTE TESTS PASSED (${pass}/${pass})` : `FAILURES: ${fail}`)
process.exit(fail ? 1 : 0)
