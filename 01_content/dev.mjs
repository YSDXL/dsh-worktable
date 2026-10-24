/**
 * dev.mjs — dsh-worktable 热更新开发构建（不重启 DSH）
 *
 * 背景：宿主 dsh-client-hmr 每 500ms 轮询各插件 client bundle 的 mtime/size，
 *       变化即经 SSE /plugins/events 推送 rebuilt 帧，浏览器端 in-place 重载该插件模块。
 *       所以把新 client.js 直接写到「运行中的 profile 里已安装的路径」，~1 秒后页面自动生效，
 *       无需重启 DSH、无需刷新页面。
 *
 * 用法（保持本进程常驻）：  npm run dev
 *   默认写入 %USERPROFILE%\.dsh-beta\profiles\desktop\node_modules\dsh-worktable\lib\client.js
 *   可用环境变量覆盖目标 profile 名或整条路径：
 *     DSH_PROFILE=web                 （换 profile 名）
 *     DSH_HOME=C:\Users\x\.dsh-beta    （换数据根）
 *     WT_DEV_TARGET=<绝对路径>\lib\client.js（直接指定输出文件）
 *
 * 只热更新 client bundle（界面代码）。服务端 src/index.ts 的改动（/api 路由等）需要重启宿主才生效。
 * 上线仍走 npm run pack 生成 tgz，本脚本不参与发布。
 */
import { build, context } from 'esbuild'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

const home = process.env.DSH_HOME || join(homedir(), '.dsh-beta')
const profile = process.env.DSH_PROFILE || 'desktop'
const defaultTarget = join(home, 'profiles', profile, 'node_modules', 'dsh-worktable', 'lib', 'client.js')
const target = resolve(process.env.WT_DEV_TARGET || defaultTarget)

// 只替换 outfile（保留 sourcemap 外部生成）；其余选项与 build.mjs 的客户端构建保持一致，保证产物契约相同。
const clientOptions = {
  entryPoints: [join(here, 'src/client/index.tsx')],
  outfile: target,
  bundle: true,
  sourcemap: 'external',
  logLevel: 'info',
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  loader: { '.css': 'text' },
  banner: { js: "window.__ModuleLoader__.load({ id: 'dsh-worktable', factory: (require) => { var module = { exports: {} }; var exports = module.exports;" },
  footer: { js: 'return module.exports; } });' },
  define: { __WT_VERSION__: JSON.stringify(pkg.version) },
}

mkdirSync(dirname(target), { recursive: true })
if (!existsSync(target)) {
  console.warn('[wt-dev] 目标文件尚不存在（插件未安装？）。将直接创建：' + target)
}
console.log('[wt-dev] 输出 -> ' + target)
console.log('[wt-dev] 保存 src/ 下文件即自动重建；宿主 dsh-client-hmr 约 1 秒内推送浏览器热重载（无需重启/刷新）。Ctrl+C 退出。')

const ctx = await context(clientOptions)
await ctx.watch()
