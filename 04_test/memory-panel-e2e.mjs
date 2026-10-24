import http from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const json = (res, s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d || '{}')) })

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/api/worktable/write') {
    const b = JSON.parse(await readBody(req))
    await writeFile(resolve(b.path), b.content ?? '', 'utf8')
    return json(res, 200, { ok: true })
  }
  if (u.pathname === '/api/worktable/file') {
    try { const d = await readFile(resolve(u.searchParams.get('path')), 'utf8'); res.writeHead(200); res.end(d) }
    catch { res.writeHead(404); res.end() }
    return
  }
  if (u.pathname === '/api/worktable/delete') {
    const b = JSON.parse(await readBody(req))
    if (!/\.(md|markdown)$/i.test(b.path)) return json(res, 400, { error: 'only .md files can be deleted here' })
    await unlink(resolve(b.path))
    return json(res, 200, { ok: true })
  }
  json(res, 404, {})
})
await new Promise((r) => srv.listen(0, r))
const port = srv.address().port
const base = 'http://127.0.0.1:' + port
const dir = process.argv[2]
const P = (n) => dir + '/' + n
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { ok: r.ok, body: await r.json() } }
let fail = 0
const chk = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++ }

chk('write AGENTS.md', (await post('/api/worktable/write', { path: P('AGENTS.md'), content: '# 项目规则\n- 先给结论\n' })).ok)
const got = await (await fetch(base + '/api/worktable/file?path=' + encodeURIComponent(P('AGENTS.md')))).text()
chk('read back AGENTS.md identical', got === '# 项目规则\n- 先给结论\n')
chk('create notes.md', (await post('/api/worktable/write', { path: P('notes.md'), content: '# notes\n' })).ok)
chk('delete notes.md', (await post('/api/worktable/delete', { path: P('notes.md') })).ok)
const bad = await post('/api/worktable/delete', { path: P('app.js') })
chk('reject deleting non-.md', !bad.ok && !!bad.body.error)
chk('404 for missing file (treated as empty)', (await fetch(base + '/api/worktable/file?path=' + encodeURIComponent(P('nope.md')))).status === 404)

console.log(fail === 0 ? 'ALL MEM E2E PASSED' : 'FAILURES: ' + fail)
srv.close()
process.exit(fail ? 1 : 0)
