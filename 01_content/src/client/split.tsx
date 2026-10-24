import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { parentPathOf, joinPath } from './pathutil'
import { hostWebSocketUrl, worktableUpgrade } from './hostTransport'
import { CHANGELOG_V030 } from './changelog'
import { LOCAL_VERSION, checkUpdate, getAutoCheck, readCache, setAutoCheck as storeAutoCheck, setSkipVersion, type UpdateInfo, type UpdateStatus } from './updateCheck'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import hljsTypescript from 'highlight.js/lib/languages/typescript'
import hljsJavascript from 'highlight.js/lib/languages/javascript'
import hljsCss from 'highlight.js/lib/languages/css'
import hljsJson from 'highlight.js/lib/languages/json'

hljs.registerLanguage('typescript', hljsTypescript)
hljs.registerLanguage('javascript', hljsJavascript)
hljs.registerLanguage('css', hljsCss)
hljs.registerLanguage('json', hljsJson)

/**
 * dsh-worktable 乐高式工作区 M1：通用分栏引擎（PRD §13）。
 * 布局模型：标题栏 + 顶部通栏行(可选) + 主行内容窗 + 聊天窗（官方会话视图区整体，
 * 贴右或贴左，由 chatSide 决定；marginLeft/marginRight + marginTop 组合挤法）。
 * 内容三态：null（未指派 → 6 选 1 选择器）/ iframe / builtin（浏览器/资源管理器/SCM/任务/终端）。
 * 窗位调整：标题栏拖拽换位（同行或跨行）；工具栏 ⇄ 切换聊天窗左右。
 * 会话切换重新锚定不关闭；宽度按 layoutId 持久化 dsh.worktable.split.v2；
 * 内容与 chatSide 的变更经 onSpecMutated 回调交给工作台持久化（布局条目）。
 */

export type BuiltinType = 'browser' | 'anim' | 'explorer' | 'scm' | 'tasks' | 'terminal' | 'custom' | 'console'

export type SplitContent =
  | { kind: 'iframe'; url: string; title?: string }
  | { kind: 'builtin'; type: BuiltinType; url?: string }
  | { kind: 'file'; path: string }

/** 一个内容标签页 */
export type PaneTab = { id: string; title: string; content: SplitContent }

export type SplitPane = {
  id: string
  title: string
  min: number
  /** 向后兼容：单内容声明（打开时归一化为一个标签页） */
  content?: SplitContent | null
  /** 标签页模型：内容标签列表（空 = 未指派，显示 6 选 1 选择器） */
  tabs?: PaneTab[]
  /** 激活的标签下标 */
  active?: number
  /** 头部折叠：true = 隐藏窗格标题与标签栏（内容占满；随 spec 持久化） */
  collapsed?: boolean
}

export type LayoutSpec = {
  id: string
  title: string
  top: SplitPane[] | null
  main: SplitPane[]
  /** 左列整高内容窗（可选；存在时右侧列 = top 行 + 底部聊天，chatSide 固定 right） */
  left?: SplitPane | null
  leftWidth?: { default: number; min: number; max: number }
  chatWidth: { default: number; min: number; max: number }
  topHeight?: { default: number; min: number; max: number }
  /** 聊天窗贴边位置：'right'（右列/右下，默认）| 'left'（左列/左下） */
  chatSide?: 'left' | 'right'
  /** 布局条目图标（emoji；工作台侧栏展示，点击可换） */
  icon?: string
  /** 聊天窗通高（整列）：为 true 时聊天占整条右/左列，内容区（含 top 行）全部排在其另一侧 */
  chatFullHeight?: boolean
  /** 顶行首次打开时高度占可用高度比例（0~1；0.5 = 上下等分）；拖动后由存档值覆盖 */
  topHeightRatio?: number
}

type Geom = { left: number; top: number; right: number; bottom: number }

type PaneRow = 'left' | 'top' | 'main'

type SplitState = {
  active: boolean
  spec: LayoutSpec | null
  geom: Geom | null
  chatW: number
  topH: number
  leftW: number
  paneWs: number[]
  topWs: number[]
  leftWs: number[]
  root: HTMLElement | null
  header: HTMLElement | null
  viewArea: HTMLElement | null
  savedMarginLeft: string
  savedMarginRight: string
  savedMarginTop: string
  /** 打开前会话根上 --dsh-chat-user-width 的内联值（关闭时原样恢复；0.1.1 上该变量闲置无害） */
  savedWidthVar: string
  observer: ResizeObserver | null
  fallback: MutationObserver | null
  yieldObserver: MutationObserver | null
  lastMarginLeft: string
  lastMarginRight: string
  lastMarginTop: string
  onSpecMutated: ((spec: LayoutSpec) => void) | null
  /** Manual edits revoke that pane's automatic result binding; lockPane itself does not. */
  onPaneContentEdited: ((projectId: string, paneId: string) => void) | null
  listeners: Set<() => void>
  open(spec: LayoutSpec): boolean
  close(): void
  syncAnchor(): void
  refreshGeom(): void
  applyMargin(): void
  setChatW(w: number): void
  setTopH(h: number): void
  setLeftW(w: number): void
  setPaneW(i: number, w: number): void
  setTopW(i: number, w: number): void
  setPaneContent(row: PaneRow, i: number, content: SplitContent | null): void
  openTab(row: PaneRow, i: number, content: SplitContent): void
  /** 锁定窗格：清空原有标签，把内容作为该窗唯一的固定标签（挂载产物的「锁死」语义） */
  lockPane(row: PaneRow, i: number, content: SplitContent): void
  closeTab(row: PaneRow, i: number, tabId: string): void
  /** 布局随时修改：在指定行右侧/下方拆出一个新窗格（标签对半搬过去），返回新下标 */
  splitPane(row: PaneRow, i: number, dir: 'right' | 'down'): number
  /** 布局随时修改：关闭指定窗格（标签先搬去邻居，不丢内容）；最后一个窗格拒绝 */
  closePane(row: PaneRow, i: number): boolean
  setActiveTab(row: PaneRow, i: number, tabId: string): void
  toggleCollapsed(row: PaneRow, i: number): void
  moveTab(fromRow: PaneRow, fromI: number, tabId: string, toRow: PaneRow, toI: number): void
  swapPanes(aRow: PaneRow, aI: number, bRow: PaneRow, bI: number): void
  setChatSide(side: 'left' | 'right'): void
  persist(): void
  subscribe(fn: () => void): () => void
  notify(): void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const GAP = 1           // 窗格之间真实布局间隙：1px（分隔细线即间隙，底色贴线）
const DIVIDER = 4       // 分隔条热区宽度：透明覆盖层，细线画在热区中间与两侧内容贴齐
const BAR_H = 26
const PERSIST_KEY = 'dsh.worktable.split.v2'
/** 单行最多窗格数（布局随时修改的上限；超出拒绝拆分） */
const MAX_PANES_PER_ROW = 6

/** 内置内容窗图标 */
const BUILTIN_ICONS: Record<BuiltinType, string> = {
  browser: '🌐',
  anim: '🎬',
  explorer: '📁',
  scm: '🔀',
  tasks: '✅',
  terminal: '▸_',
  custom: '✨',
  console: '🖥️',
}

const BUILTIN_LABEL_KEYS: Record<BuiltinType, string> = {
  browser: 'pane.browser',
  anim: 'pane.anim',
  explorer: 'pane.explorer',
  scm: 'pane.scm',
  tasks: 'pane.tasks',
  terminal: 'pane.terminal',
  custom: 'pane.custom',
  console: 'pane.console',
}

function tabTitleOf(content: SplitContent): string {
  if (content.kind === 'builtin') return T(BUILTIN_LABEL_KEYS[content.type])
  if (content.kind === 'file') return basenameOf(content.path)
  if (content.kind === 'iframe' && content.title) return content.title
  try {
    const u = new URL(content.url)
    return u.hostname || content.url
  } catch {
    return content.url
  }
}

/** 取路径最后一段作为标签标题 */
function basenameOf(p: string): string {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p)
}

/** 内容同一性（openTab 去重：同窗内同内容只保留一个标签，再次打开切过去） */
function sameContent(a: SplitContent, b: SplitContent): boolean {
  if (a.kind === 'iframe' && b.kind === 'iframe') return a.url === b.url
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.type === b.type
  return false
}

/** 分栏 UI 文案提供者（由工作台注入 locale t） */
let uiT: ((key: string, params?: Record<string, string>) => string) | null = null
export function setSplitT(fn: ((key: string, params?: Record<string, string>) => string) | null) {
  uiT = fn
}
const T = (key: string, params?: Record<string, string>): string => (uiT ? uiT(key, params) : key)

/** 工作区环境（由工作台注入：当前会话作用域与后台任务列表） */
export type SplitScope = { sessionId: string; cwd: string }
export type SplitJob = {
  id: string
  kind: string
  label: string
  status: string
  detail?: string
  startedAt: number
  finishedAt?: number
}
/** 控制室卡片数据（index.tsx 组装；纯读镜像，零轮询零 Token） */
export type ConsoleCardData = {
  id: string
  name: string
  icon: string
  /** 三态 + 空闲：need(待决黄) > done(完成绿) > busy(工作中蓝) > idle */
  status: 'idle' | 'busy' | 'need' | 'done'
  /** 正在运行时的本轮已用毫秒；非运行态 null */
  runtimeMs: number | null
  /** 子代理数量 */
  kids: number
  /** 最近一条消息预览（单行文本，可能为空） */
  preview: string
  /** 是否绑定对话 */
  bound: boolean
  /** 是否为「工作台」自己（卡片点击无操作） */
  self: boolean
  /** 完成/待决且未被确认：卡片发对应色光（点击确认后熄灭） */
  glow: boolean
}

type SplitEnv = {
  fillHostInput: (text: string) => boolean
  getScope: () => SplitScope | null
  getJobs: () => SplitJob[]
  getSubagents: () => any[]
  /** 该项目绑定的会话是否正在运行（用于保活判定：运行中的工作台不回收） */
  isProjectRunning?: (projectId: string) => boolean
  /** 自定义窗口：项目列表 + 会话列表 + 当前项目 + 新建会话 / 发送到已有会话 */
  custom?: {
    getProjects: () => { id: string; name: string }[]
    currentProjectId: () => string | null
    getSessions: () => Promise<{ groups: { title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]; current: string }>
    submit: (projectId: string, projectName: string, requirement: string) => Promise<void>
    sendToSession: (sessionId: string, projectName: string, requirement: string) => Promise<void>
  }
  /** 控制室：卡片数据订阅 + 打开项目 / 跳绑定对话 + 主题 */
  console?: {
    subscribe: (fn: () => void) => () => void
    getCards: () => ConsoleCardData[]
    /** 当前项目文件夹（项目记忆面板用；空 = 未设置） */
    getProjectFolder?: () => string
    /** 当前项目显示名（项目记忆面板标题用） */
    getProjectName?: () => string
    onOpen: (id: string) => void
    onJump: (id: string) => void
    /** 点发光卡片：确认（熄灭光）再打开 */
    onAck: (id: string) => void
    /** 冷会话消息预热（打开控制室时拉最近消息） */
    refreshPreviews: () => void
    /** 创建卡片：打开「添加项目」流程（同侧栏 ＋） */
    onAdd: () => void
    getTheme: () => 'dark' | 'light' | 'system'
    setTheme: (th: 'dark' | 'light' | 'system') => void
    getCols: () => number
    setCols: (n: number) => void
    getShape: () => 'square' | 'circle'
    setShape: (s: 'square' | 'circle') => void
    getBg: () => 'plain' | 'glow' | 'photo'
    setBg: (m: 'plain' | 'glow' | 'photo') => void
    getPhotoLib: () => Promise<{ list: { id: string; kind: 'photo' | 'video'; url: string }[]; activeId: string | null }>
    addPhoto: (blob: Blob) => Promise<{ id: string; kind: 'photo' | 'video'; url: string }>
    setPhotoId: (id: string) => void
    getPhotoHsl: (id: string) => { h: number; s: number; l: number }
    setPhotoHsl: (id: string, v: { h: number; s: number; l: number }) => void
    removePhoto: (id: string) => Promise<void>
    reorderPhotos: (ids: string[]) => Promise<void>
    getPhotoGrid: () => boolean
    setPhotoGrid: (v: boolean) => void
    getGridOpacity: () => number
    setGridOpacity: (v: number) => void
    getCardBlur: () => number
    setCardBlur: (v: number) => void
    getPlainBlur: () => number
    setPlainBlur: (v: number) => void
    getGlowBlur: () => number
    setGlowBlur: (v: number) => void
    getPlainGrid: () => number
    setPlainGrid: (v: number) => void
    getGlowGrid: () => number
    setGlowGrid: (v: number) => void
    getGlowSpeed: () => number
    setGlowSpeed: (v: number) => void
    getPlainHsl: () => { h: number; s: number; l: number }
    setPlainHsl: (v: { h: number; s: number; l: number }) => void
    getGlowHsl: () => { h: number; s: number; l: number }
    setGlowHsl: (v: { h: number; s: number; l: number }) => void
    getPhotoHsl: () => { h: number; s: number; l: number }
    setPhotoHsl: (v: { h: number; s: number; l: number }) => void
  }
}
let splitEnv: SplitEnv | null = null
export function setSplitEnv(env: SplitEnv | null) {
  splitEnv = env
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** 拖拽换位暂存 */
let dragPane: { row: PaneRow; index: number } | null = null
/** 标签拖拽暂存（跨窗移动） */
let dragTab: { row: PaneRow; index: number; tabId: string } | null = null
/** 标签拖放目标（吸附高亮；模块级，PaneBody 与窗容器共用） */
let dropTarget: { row: PaneRow; index: number } | null = null
let dropTargetListeners: Set<() => void> = new Set()
function setDropTarget(t: { row: PaneRow; index: number } | null) {
  if (dropTarget === t) return
  dropTarget = t
  for (const fn of dropTargetListeners) fn()
}

/** 拖标签后吞掉紧随的那次 click（借鉴 DSH-P「标签交互」①）：
 *  HTML5 DnD 的 dragend 之后浏览器仍会派发一次 click，落到原标签上就会
 *  「拖完标签顺带把它设为激活」——本意只是挪位置的那一下变成了切换。
 * 做法：dragend 时打标，click 在 capture 阶段被拦掉，500ms 后自动解标。 */
const tabDragMoved = { current: false }
let tabClickSuppressUntil = 0
let tabClickSuppressTimer: number | null = null
function suppressTabClick() {
  tabClickSuppressUntil = Date.now() + 500
  if (tabClickSuppressTimer != null) window.clearTimeout(tabClickSuppressTimer)
  tabClickSuppressTimer = window.setTimeout(() => {
    tabClickSuppressTimer = null
    tabClickSuppressUntil = 0
  }, 500)
}
/** 当前是否处于「拖拽后吞 click」窗口（供 onClick 判定） */
function tabClickSuppressed(): boolean {
  return Date.now() < tabClickSuppressUntil
}

/** ——「指哪打哪」标注引擎：按钮 → 蓝色冒泡光标 → 点击弹输入框 → ✓ 打包进对话框（不发送） —— */
type AnnotState = {
  on: boolean
  started: boolean
  drawing: boolean
  px: number
  py: number
  bx0: number
  by0: number
  bx1: number
  by1: number
  ex: number
  ey: number
  draft: string
  resp: string
  stat: string
}
let annotState: AnnotState = { on: false, started: false, drawing: false, px: 0, py: 0, bx0: 0, by0: 0, bx1: 0, by1: 0, ex: 0, ey: 0, draft: '', resp: '', stat: '' }
const annotListeners = new Set<() => void>()
function setAnnot(patch: Partial<AnnotState>) {
  annotState = { ...annotState, ...patch }
  for (const fn of annotListeners) fn()
}
function subscribeAnnot(fn: () => void) { annotListeners.add(fn); return () => { annotListeners.delete(fn) } }

/** 窗格右键菜单：位置 + 目标窗格（模块级；WorkspaceLayer 渲染一次，fixed 定位） */
let ctxMenu: { x: number; y: number; row: PaneRow; index: number } | null = null
const ctxListeners = new Set<() => void>()
function setCtxMenu(v: { x: number; y: number; row: PaneRow; index: number } | null) { ctxMenu = v; for (const fn of ctxListeners) fn() }
function subscribeCtx(fn: () => void) { ctxListeners.add(fn); return () => { ctxListeners.delete(fn) } }

/** 进入瞄准模式（resp = 窗口编号等上下文，由调用方拼好） */
function startAnnot(resp: string) {
  document.body.classList.add('dsh-wt-annotating')
  setAnnot({ on: true, started: false, drawing: false, resp, stat: '', draft: '' })
}
function cancelAnnot() {
  document.body.classList.remove('dsh-wt-annotating')
  setAnnot({ on: false, started: false, drawing: false })
}

/** 窗口身份（约定：左栏 → 顶行 → 主行，从 1 起；附窗格标题与内容类型/URL，让接收方无需猜"这是哪个界面"） */
function windowLabelOf(row: PaneRow, index: number): string {
  const spec = splitStore.spec
  if (!spec) return '窗口?'
  let num = spec.left ? 2 : 1
  if (row === 'left') num = 1
  else if (row === 'top') num = num + index
  else { num += (spec.top?.length ?? 0) + index }
  let label = '窗口' + num
  const pane = row === 'left' ? spec.left : row === 'top' ? spec.top?.[index] : spec.main?.[index]
  const title = pane?.title
  if (title) label += '「' + title + '」'
  const tab = pane?.tabs?.[pane.active ?? 0]
  const c = tab?.content
  if (c) {
    try {
      if (c.kind === 'iframe' && c.url) label += '（网页 ' + new URL(c.url).hostname + '）'
      else if (c.kind === 'builtin') {
        label += '（内置·' + c.type
        try { if (c.url) label += ' ' + new URL(c.url).hostname } catch {}
        label += '）'
      }
      else if (c.kind === 'file') label += '（文件）'
    } catch {}
  }
  return label
}

/** 被点元素上下文（标签 + 类名 + 文字） */
function ctxOf(t: EventTarget | null): string {
  const el = t instanceof Element ? t : null
  if (!el || el === document.documentElement || el === document.body) return ''
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.')
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  let out = '<' + tag + (cls ? ' .' + cls : '') + '>'
  if (text) out += '「' + text + '」'
  try { const cs = getComputedStyle(el); out += '（字号 ' + cs.fontSize + '）' } catch {}
  return out
}

/** 框选 payload v3.1：主目标 = 框中心点【光标下的字符】所在的 Text 节点（caretPositionFromPoint，
 *  标签即使不是独立元素也能取到真正的词/段）；样式取该 Text 节点的父元素（真实渲染值）；
 *  整行 = 最近的高度≤44px 祖先的内容（供「这行字是什么」类问题）；候选 = 相交的独立短文本。 */
function boxPayload(x0: number, y0: number, x1: number, y1: number): { primary: { text: string; fontSize: string; lineHeight: string; color: string } | null; line: string; candidates: string[]; limited: boolean; src: string } {
  const L = Math.min(x0, x1)
  const T = Math.min(y0, y1)
  const R = Math.max(x0, x1)
  const B = Math.max(y0, y1)
  const cx = (L + R) / 2
  const cy = (T + B) / 2
  let primary: { text: string; fontSize: string; lineHeight: string; color: string } | null = null
  let line = ''
  let candidates: string[] = []
  let limited = false
  let src = ''
  // 在某 document 内取字（rect = 该 doc 视口在顶层页面的偏移）
  const readDoc = (doc: Document, ox: number, oy: number): boolean => {
    let ok = false
    let textParent: HTMLElement | null = null
    try {
      const pd = doc as any
      const px = cx - ox
      const py = cy - oy
      let pos: any = null
      try { if (pd.caretPositionFromPoint) pos = pd.caretPositionFromPoint(px, py) } catch {}
      if (!pos) { try { if (pd.caretRangeFromPoint) pos = pd.caretRangeFromPoint(px, py) } catch {} }
      const textNode: Node | null = pos ? (pos.offsetNode ?? pos.startContainer ?? null) : null
      if (textNode) {
        const parent = textNode.parentElement
        if (parent) {
          textParent = parent
          const text = (textNode.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
          if (text) {
            const cs = getComputedStyle(parent)
            primary = { text, fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color }
            ok = true
          }
        }
      }
    } catch {}
    // 整行
    if (textParent) {
      try {
        let el: HTMLElement | null = textParent
        while (el && el !== doc.body) {
          const r = el.getBoundingClientRect()
          if (r.height >= 8 && r.height <= 44 && r.width > 0) {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
            if (t) { line = t.slice(0, 120); break }
          }
          el = el.parentElement
        }
      } catch {}
    }
    // 候选
    const seen = new Set<string>()
    if (primary) seen.add(primary.text)
    const cs: string[] = []
    try {
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
        const tag = el.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path' || tag === 'br' || tag === 'template' || tag === 'iframe') continue
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        if (rect.right + ox < L || rect.left + ox > R || rect.bottom + oy < T || rect.top + oy > B) continue
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
        if (text.length < 1 || text.length > 30) continue
        if (seen.has(text)) continue
        seen.add(text)
        cs.push(text)
        if (cs.length >= 4) break
      }
    } catch {}
    if (ok || cs.length > 0) candidates = cs
    return ok
  }
  // 1) 顶层文档
  readDoc(document, 0, 0)
  // 2) 顶层取不到 → 中心点所在 iframe 下钻（同源可读；跨域标记受限于 src）
  if (!primary) {
    try {
      for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
        try {
          const r = iframe.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue
          src = iframe.getAttribute('src') ?? ''
          let inner: Document | null = null
          try { inner = iframe.contentDocument } catch { inner = null }
          if (inner) readDoc(inner, r.left, r.top)
          else limited = true
          break
        } catch { continue }
      }
    } catch {}
  }
  return { primary, line, candidates, limited, src }
}

/** 更新方法：复制给 AI 的升级指令（插件不自更新；升级由用户或其 Agent 执行 + 重启） */
const { prompt: UPGRADE_AI } = worktableUpgrade()

async function copyTextSafe(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true } } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

/** 注入宿主对话框输入框（不发送）；失败返回 false */
function fillHostInput(text: string): boolean {
  return splitEnv?.fillHostInput(text) ?? false
}

/** ✓ 确认：打包并注入，不发送 */
function confirmAnnot() {
  const s = annotState
  const text = '📌 标注-' + s.resp + '\n' + (s.stat || '') + '\n要求：' + (s.draft.trim() || '（未填写）')
    + '\n【工作台标注·已定位，直接作答，无需再问；仅当确实无法从标注定位时才问一次。数据缺失或标注标注读取受限时，如实说明无法确定，禁止编造数值；可建议提供截图或使用视觉模型会话】'
  const ok = fillHostInput(text)
  if (!ok) {
    try {
      navigator.clipboard?.writeText(text).catch(() => { try { window.prompt('标注已生成，请手动复制：', text) } catch {} })
    } catch {
      try { window.prompt('标注已生成，请手动复制：', text) } catch {}
    }
  }
  cancelAnnot()
}

/** 标注浮层：瞄准气泡 + 输入编辑器（每个工作区渲染一次；fixed 定位） */
function AnnotationOverlay() {
  const [, setTick] = useState(0)
  useEffect(() => subscribeAnnot(() => setTick((t) => t + 1)), [])
  const s = annotState
  useEffect(() => {
    if (!s.on || s.started) return
    let sx = 0
    let sy = 0
    let dragging = false
    const isUi = (e: MouseEvent) => e.target instanceof Element && e.target.closest('.dsh-wt_annotUi') != null
    const onMove = (e: MouseEvent) => {
      if (!annotState.on || annotState.started) return
      if (annotState.drawing) setAnnot({ bx1: e.clientX, by1: e.clientY, px: e.clientX, py: e.clientY })
      else setAnnot({ px: e.clientX, py: e.clientY })
    }
    const onDown = (e: MouseEvent) => {
      if (!annotState.on || annotState.started || isUi(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      sx = e.clientX
      sy = e.clientY
      dragging = true
      setAnnot({ drawing: true, bx0: sx, by0: sy, bx1: sx, by1: sy })
    }
    const onUp = (e: MouseEvent) => {
      if (!annotState.on || annotState.started || !dragging) return
      e.preventDefault()
      e.stopImmediatePropagation()
      dragging = false
      const w = Math.abs(e.clientX - sx)
      const h = Math.abs(e.clientY - sy)
      const paneEl = (e.target instanceof Element ? e.target.closest('.dsh-wt_pane') : null) as HTMLElement | null
      let stat = ''
      if (Math.max(w, h) >= 8) {
        // 框选：中心/宽高 + 窗口内百分比 + 框内可见文字聚合
        const L = Math.min(sx, e.clientX)
        const T = Math.min(sy, e.clientY)
        const R = Math.max(sx, e.clientX)
        const B = Math.max(sy, e.clientY)
        stat = '框选屏幕 (' + Math.round(L) + ',' + Math.round(T) + ') → (' + Math.round(R) + ',' + Math.round(B) + ') 宽高 (' + Math.round(w) + '×' + Math.round(h) + 'px)'
        if (paneEl) {
          const pr = paneEl.getBoundingClientRect()
          const rx1 = (((L - pr.left) / Math.max(1, pr.width)) * 100).toFixed(1)
          const ry1 = (((T - pr.top) / Math.max(1, pr.height)) * 100).toFixed(1)
          const rx2 = (((R - pr.left) / Math.max(1, pr.width)) * 100).toFixed(1)
          const ry2 = (((B - pr.top) / Math.max(1, pr.height)) * 100).toFixed(1)
          stat += '，窗口内 (' + rx1 + '%,' + ry1 + '%)→(' + rx2 + '%,' + ry2 + '%)'
        }
        const hit = boxPayload(L, T, R, B)
        // 浏览器窗：点/框落在内嵌 iframe（跨域页面）上时，DOM 读不到，只给网页区域 + URL，
        // 且绝不再把本插件窗框（↻/✕/↗）误当"主目标"。
        let onIframe: HTMLIFrameElement | null = null
        if (paneEl) {
          try {
            const ccx = (L + R) / 2, ccy = (T + B) / 2
            onIframe = Array.from(paneEl.querySelectorAll('iframe')).find((f) => {
              const r = f.getBoundingClientRect()
              return r.width > 0 && r.height > 0 && ccx >= r.left && ccx <= r.right && ccy >= r.top && ccy <= r.bottom
            }) as HTMLIFrameElement | undefined ?? null
          } catch {}
        }
        if (onIframe) {
          const ir = onIframe.getBoundingClientRect()
          let host = '页面'
          try { host = new URL(onIframe.getAttribute('src') || '', location.href).hostname || '页面' } catch {}
          const rx1 = (((L - ir.left) / Math.max(1, ir.width)) * 100).toFixed(1)
          const ry1 = (((T - ir.top) / Math.max(1, ir.height)) * 100).toFixed(1)
          const rx2 = (((R - ir.left) / Math.max(1, ir.width)) * 100).toFixed(1)
          const ry2 = (((B - ir.top) / Math.max(1, ir.height)) * 100).toFixed(1)
          stat += '，网页「' + host + '」内区域 (' + rx1 + '%,' + ry1 + '%)→(' + rx2 + '%,' + ry2 + '%)'
          stat += '；跨域页面 DOM 不可读取（浏览器安全限制），只能按区域描述，窗口身份见上（' + (onIframe.getAttribute('src') || '无URL') + '）'
        } else {
          if (hit.primary) stat += '，主目标：' + hit.primary.text + '（字号 ' + hit.primary.fontSize + '，行高 ' + hit.primary.lineHeight + '）'
          if (hit.line) stat += '；整行：' + hit.line
          if (hit.limited) stat += '；读取受限：跨域页面内容不可见（浏览器安全限制），窗口身份见上（' + (hit.src ? hit.src : '无URL') + '）'
          if (hit.candidates.length > 0) stat += '；候选：' + hit.candidates.map((t, i) => '[' + (i + 1) + ']' + t).join(' ')
        }
      } else {
        stat = '屏幕坐标 (' + Math.round(e.clientX) + ', ' + Math.round(e.clientY) + ')'
        if (paneEl) {
          const r = paneEl.getBoundingClientRect()
          const rx = (((e.clientX - r.left) / Math.max(1, r.width)) * 100).toFixed(1)
          const ry = (((e.clientY - r.top) / Math.max(1, r.height)) * 100).toFixed(1)
          stat += '，窗口内 (' + rx + '%, ' + ry + '%)'
        }
        const ctx = ctxOf(e.target)
        if (ctx) stat += '，元素 ' + ctx
      }
      document.body.classList.remove('dsh-wt-annotating')
      const ex = Math.max(8, Math.min(e.clientX + 10, window.innerWidth - 288))
      const ey = Math.max(8, Math.min(e.clientY + 14, window.innerHeight - 148))
      setAnnot({ started: true, drawing: false, ex, ey, stat })
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelAnnot() }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.on, s.started])
  // 首次进入标注：右侧气泡提示「拖动也可框选」，仅显示一次
  const [hintOnce] = useState<boolean>(() => { try { return localStorage.getItem('dsh.worktable.annotHint.v1') !== '1' } catch { return false } })
  const [hintVisible, setHintVisible] = useState(false)
  useEffect(() => {
    if (!s.on || !hintOnce) return
    setHintVisible(true)
    try { localStorage.setItem('dsh.worktable.annotHint.v1', '1') } catch {}
    const t = window.setTimeout(() => setHintVisible(false), 4200)
    return () => window.clearTimeout(t)
  }, [s.on, hintOnce])
  if (!s.on) return null
  {hintVisible && (
    <div className="dsh-wt_annotUi dsh-wt_annotHint">{T('annot.hint')}</div>
  )}
  if (s.drawing) {
    const L = Math.min(s.bx0, s.bx1)
    const T = Math.min(s.by0, s.by1)
    const R = Math.max(s.bx0, s.bx1)
    const B = Math.max(s.by0, s.by1)
    return <div className="dsh-wt_annotUi dsh-wt_annotSel" style={{ left: L, top: T, width: R - L, height: B - T }} />
  }
  if (!s.started) {
    return (
      <div className="dsh-wt_annotUi dsh-wt_annotBubble" style={{ left: s.px, top: s.py }} aria-hidden>
        <svg width="12" height="12" viewBox="0 0 16 16"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </div>
    )
  }
  return (
    <div className="dsh-wt_annotUi dsh-wt_annotEditor" style={{ left: s.ex, top: s.ey }}>
      <textarea
        className="dsh-wt_annotInput"
        autoFocus
        value={s.draft}
        placeholder={T('annot.placeholder')}
        onChange={(e) => setAnnot({ draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmAnnot() }
          if (e.key === 'Escape') cancelAnnot()
        }}
      />
      <div className="dsh-wt_annotBtns">
        <button type="button" className="dsh-wt_annotOk" title={T('annot.ok')} aria-label={T('annot.ok')} onClick={confirmAnnot}>✓</button>
        <button type="button" className="dsh-wt_annotNo" title={T('annot.cancel')} aria-label={T('annot.cancel')} onClick={cancelAnnot}>✕</button>
      </div>
    </div>
  )
}

/** 找到会话根容器：data-phase 元素中排除输入框、取含子元素者。
 * DSH 0.1.1-rc.2 与 0.1.2-rc.1 的会话阶段一致：active（有消息）/ hero（无会话或空会话）/ settling（过渡）。
 * 优先 active，其次 hero（空会话/无会话时也能打开分栏），settling 兜底（锚定后由观察器修正）。 */
function findConversationRoot(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-phase]'))
  const ok = (el: HTMLElement) => el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT'
    && el.children.length >= 1 && !/input/i.test(String(el.className))
  const rank = (el: HTMLElement) => (el.dataset.phase === 'active' ? 0 : el.dataset.phase === 'hero' ? 1 : 2)
  let best: HTMLElement | null = null
  let bestRank = Infinity
  for (const el of candidates) {
    if (!ok(el)) continue
    const r = rank(el)
    if (r < bestRank) { bestRank = r; best = el }
  }
  return best
}

/** 从首个槽位元素里解析「可见头部」：
 * - 0.1.1：children[0] 就是 <header> 本身（可见时自身有高度）。
 * - 0.1.2：children[0] 是零高的槽位包装（display:contents 式），真实头部渲染在其内部——
 *   此时向内找第一个可见后代（文档序 = 头部自身，先于其子元素）。
 * - 空会话（headerHidden，整棵子树 display:none）：找不到任何可见元素 → null（顶部 = 根顶部）。 */
function visibleHeaderIn(first: HTMLElement): HTMLElement | null {
  if (first.getBoundingClientRect().height > 0) return first
  for (const el of Array.from(first.querySelectorAll<HTMLElement>('*'))) {
    const r = el.getBoundingClientRect()
    if (r.height > 0 && r.width > 0) return el
  }
  return null
}

/** 从会话根解析分栏锚点（兼容 0.1.1 与 0.1.2 两种 DOM 结构）：
 * - 0.1.1 与 0.1.2 会话打开：root.children = [头部(或头部包装), 内容滚动区]（0.1.2 多一层 body 包装，不影响取 children[1]）。
 * - 0.1.2 无会话：root.children = [body]（无头部元素）。
 * - 空会话（blank）：头部带 headerHidden 样式（高度为 0），按「无头部」处理（顶部 = 根顶部）。
 * header 仅当存在第二个子元素且能解析出可见头部时生效；viewArea = 第二个子元素，只有一个时 = 第一个。 */
function resolveAnchor(root: HTMLElement): { header: HTMLElement | null; viewArea: HTMLElement } {
  const first = root.children[0] as HTMLElement | undefined
  const second = root.children[1] as HTMLElement | undefined
  const header = !!second && !!first ? visibleHeaderIn(first) : null
  return { header, viewArea: second ?? first! }
}

function loadSaved(layoutId: string): { chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[]; leftWs: number[] } | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)?.[layoutId]
    if (!s || typeof s !== 'object') return null
    return {
      chatW: Number.isFinite(s.chatW) ? s.chatW : -1,
      topH: Number.isFinite(s.topH) ? s.topH : -1,
      leftW: Number.isFinite(s.leftW) ? s.leftW : -1,
      paneWs: Array.isArray(s.paneWs) ? s.paneWs : [],
      topWs: Array.isArray(s.topWs) ? s.topWs : [],
      leftWs: Array.isArray(s.leftWs) ? s.leftWs : [],
    }
  } catch {
    return null
  }
}

function persistSaved(layoutId: string, s: { chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[]; leftWs: number[] }) {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    const all = raw ? JSON.parse(raw) : {}
    all[layoutId] = s
    localStorage.setItem(PERSIST_KEY, JSON.stringify(all))
  } catch {}
}

/** 共享互斥协议：其他接入本协议的分栏引擎声明占用时，本引擎让位（同一时刻仅一个分栏工作区） */
window.addEventListener('dsh:split-claim', ((e: any) => {
  const id = e?.detail?.id
  if (splitStore.active && id && id !== splitStore.spec?.id) splitStore.close()
}) as EventListener)

export const splitStore: SplitState = {
  active: false,
  spec: null,
  geom: null,
  chatW: 320,
  topH: 200,
  leftW: 260,
  paneWs: [],
  topWs: [],
  leftWs: [],
  root: null,
  header: null,
  viewArea: null,
  savedMarginLeft: '',
  savedMarginRight: '',
  savedMarginTop: '',
  savedWidthVar: '',
  observer: null,
  fallback: null,
  yieldObserver: null,
  lastMarginLeft: '',
  lastMarginRight: '',
  lastMarginTop: '',
  onSpecMutated: null,
  onPaneContentEdited: null,
  listeners: new Set(),

  open(spec) {
    if (this.active) {
      // 同一布局再点 = 保持打开（不关闭、不重建，避免闪烁/卡顿）；不同布局 = 替换（先关旧的）
      if (this.spec?.id === spec.id) return true
      this.close()
    }
    // 跨插件互操作桥：自带分栏实现的入驻插件（未接入共享引擎）打开时，运行时点击其关闭按钮让位
    try {
      const taClose = document.querySelector<HTMLElement>('.ta_splitClose')
      taClose?.click()
    } catch {}
    // 声明占用：接入共享协议的其他引擎收到后让位
    try {
      window.dispatchEvent(new CustomEvent('dsh:split-claim', { detail: { id: spec.id } }))
    } catch {}
    const root = findConversationRoot()
    // DOM 里没有会话根（无头/测试/会话未挂载）时仍要能打开布局：
    // 布局结构与增删窗格不依赖 DOM，只有锚点挂载需要它 —— 缺失就跳过挂载，不返回 false。
    const anchor = root ? resolveAnchor(root) : null
    const { header, viewArea } = anchor ?? { header: null, viewArea: null }
    this.spec = { ...spec, chatSide: spec.chatSide === 'left' ? 'left' : 'right' }
    // 向后兼容归一化：单内容声明 → 一个标签页
    const normalize = (p: SplitPane): SplitPane => {
      if (p.tabs && p.tabs.length > 0) return p
      if (p.content) {
        return { ...p, content: null, tabs: [{ id: 't1', title: tabTitleOf(p.content), content: p.content }], active: 0 }
      }
      return { ...p, content: null, tabs: [], active: 0 }
    }
    if (spec.top) this.spec.top = spec.top.map(normalize)
    if (spec.left) this.spec.left = normalize(spec.left)
    this.spec.main = (spec.main ?? []).map(normalize)
    const main = this.spec.main ?? []
    const top = spec.top ?? []
    const left = spec.left ?? null
    const saved = loadSaved(spec.id)
    const hasChatW = !!saved && saved.chatW >= 0
    const hasTopH = !!saved && saved.topH >= 0
    const hasLeftW = !!saved && saved.leftW >= 0
    const hasPaneWs = !!saved && saved.paneWs.length === main.length
    const hasTopWs = !!saved && saved.topWs.length === top.length
    const hasLeftWs = !!saved && saved.leftWs.length === (left ? 1 : 0)
    this.chatW = hasChatW ? saved!.chatW : spec.chatWidth.default
    this.topH = hasTopH ? saved!.topH : (spec.topHeight?.default ?? 200)
    this.leftW = hasLeftW ? saved!.leftW : (spec.leftWidth?.default ?? 260)
    this.paneWs = hasPaneWs ? [...saved!.paneWs] : main.map((p) => p.min)
    this.topWs = hasTopWs ? [...saved!.topWs] : top.map((p) => p.min)
    this.leftWs = hasLeftWs ? [...saved!.leftWs] : (left ? [left.min] : [])
    this.root = root
    this.header = header
    this.viewArea = viewArea
    // 无 DOM 锚点时没有可保存的原值（close 也不该恢复）—— 存空串即可
    this.savedWidthVar = root ? root.style.getPropertyValue('--dsh-chat-user-width') : ''
    this.savedMarginLeft = viewArea ? viewArea.style.marginLeft : ''
    this.savedMarginRight = viewArea ? viewArea.style.marginRight : ''
    this.savedMarginTop = viewArea ? viewArea.style.marginTop : ''
    this.refreshGeom()
    // 存档 sanitize：chatW 等尺寸按本布局规格钳制（防老版本/脏存值越界，如 1067 > max 600）
    if (this.geom) {
      const minContent = main.reduce((a: number, p: SplitPane) => a + p.min, 0) + Math.max(0, main.length - 1) * GAP
      const hi = Math.max(spec.chatWidth.min, (this.geom.right - this.geom.left) - minContent)
      this.chatW = clamp(Math.round(this.chatW), spec.chatWidth.min, hi)
    }
    // 均衡默认：无存档尺寸时按当前可用空间比例分配，
    // 不再出现“其余窗全部贴 min、最后一个吃掉全部余量”的悬殊观感。
    const g0 = this.geom
    if (g0) {
      const colW0 = g0.right - g0.left
      const rowH0 = g0.bottom - g0.top
      if (!hasChatW) {
        const hi = Math.max(spec.chatWidth.min, colW0 - 60)
        this.chatW = clamp(Math.round(colW0 * 0.3), spec.chatWidth.min, hi)
      }
      if (left && !hasLeftW) {
        const lo = spec.leftWidth?.min ?? 160
        this.leftW = clamp(Math.round(colW0 * 0.38), lo, Math.max(lo, colW0 - 260))
      }
      if (top.length > 0 && !hasTopH) {
        const lo = spec.topHeight?.min ?? 80
        const ratio = spec.topHeightRatio ?? 0.35
        this.topH = clamp(Math.round((rowH0 - BAR_H) * ratio), lo, Math.max(lo, rowH0 - BAR_H - 80))
      }
      if (!hasPaneWs) {
        const contentW = Math.max(0, colW0 - this.chatW)
        const avail = Math.max(main.length * 120, contentW - Math.max(0, main.length - 1) * GAP)
        const share = Math.round(avail / main.length)
        this.paneWs = main.map((p) => Math.max(p.min, share))
      }
      if (!hasTopWs) {
        // chatFull 时顶行只占内容侧（扣除聊天列宽）
        const chatW0 = spec.chatFullHeight === true ? this.chatW : 0
        const rowW = Math.max(0, colW0 - chatW0 - (left ? this.leftW : 0))
        const avail = Math.max(top.length * 120, rowW - Math.max(0, top.length - 1) * GAP)
        const share = Math.round(avail / top.length)
        this.topWs = top.map((p) => Math.max(p.min, share))
      }
      if (left && !hasLeftWs) this.leftWs = [Math.max(left.min, this.leftW)]
    }
    this.applyMargin()
    this.observer = new ResizeObserver(() => {
      const r = this.root
      if (!(r && r.isConnected)) { this.syncAnchor(); return }
      const anchor = resolveAnchor(r)
      if (anchor.header !== this.header || anchor.viewArea !== this.viewArea) { this.syncAnchor(); return }
      this.refreshGeom()
      this.applyMargin()
      this.notify()
    })
    this.observer.observe(root)
    // 兜底：会话根被替换/子结构变化（如 hero→active 头部出现）时 RO 可能不再回调，
    // 用 body 级 MutationObserver 驱动重锚定；锚点未变时静默（避免流式消息期间高频刷新）
    this.fallback = new MutationObserver(() => {
      const r = this.root
      if (!(r && r.isConnected)) { this.syncAnchor(); return }
      const anchor = resolveAnchor(r)
      if (anchor.header !== this.header || anchor.viewArea !== this.viewArea) this.syncAnchor()
    })
    this.fallback.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
    // 让位观察器：会话视图区 margin 被外部改写（其他未接入协议的分栏引擎接管）时关闭自身
    this.yieldObserver = new MutationObserver(() => {
      if (!this.active || !this.viewArea) return
      if (this.viewArea.style.marginLeft !== this.lastMarginLeft
        || this.viewArea.style.marginRight !== this.lastMarginRight
        || this.viewArea.style.marginTop !== this.lastMarginTop) {
        this.close()
      }
    })
    this.yieldObserver.observe(viewArea, { attributes: true, attributeFilter: ['style'] })
    this.active = true
    this.notify()
    return true
  },

  /** 会话根失效（切换会话 / hero↔active 结构变化）时重新锚定：左侧内容保持不关闭；无会话根才关闭 */
  syncAnchor() {
    if (!this.active) return
    const next = findConversationRoot()
    if (!next) {
      this.close()
      return
    }
    const ph = next.dataset.phase
    if (ph !== 'active' && ph !== 'hero') return // settling 等过渡态：保持等待（phase 变化会再次触发）
    const anchor = resolveAnchor(next)
    if (next === this.root && anchor.header === this.header && anchor.viewArea === this.viewArea) {
      // 同锚点：头部可能由隐藏变可见（hero→active），刷新几何与挤位
      this.refreshGeom()
      this.applyMargin()
      this.notify()
      return
    }
    const viewArea = anchor.viewArea
    const oldRoot = this.root
    const oldViewArea = this.viewArea
    // 恢复旧锚点（若仍连接），锚定到新会话根
    if (oldViewArea && oldViewArea.isConnected && oldViewArea !== viewArea) {
      oldViewArea.style.marginLeft = this.savedMarginLeft
      oldViewArea.style.marginRight = this.savedMarginRight
      oldViewArea.style.marginTop = this.savedMarginTop
    }
    if (oldRoot && oldRoot.isConnected && oldRoot !== next) {
      if (this.savedWidthVar) oldRoot.style.setProperty('--dsh-chat-user-width', this.savedWidthVar)
      else oldRoot.style.removeProperty('--dsh-chat-user-width')
    }
    this.root = next
    this.header = anchor.header
    this.viewArea = viewArea
    // 仅锚点元素真正更换时才记录「打开前」原值——同元素重锚（hero→active 头部出现）
    // 必须保留最初存档，否则关闭时会把已应用的 margin/变量误还原成「新原值」
    if (oldRoot !== next) {
      this.savedWidthVar = next.style.getPropertyValue('--dsh-chat-user-width')
    }
    if (oldViewArea !== viewArea) {
      this.savedMarginLeft = viewArea.style.marginLeft
      this.savedMarginRight = viewArea.style.marginRight
      this.savedMarginTop = viewArea.style.marginTop
    }
    this.observer?.disconnect()
    this.observer.observe(next)
    this.refreshGeom()
    this.applyMargin()
    this.notify()
  },

  refreshGeom() {
    const root = this.root
    if (!root) return
    const rr = root.getBoundingClientRect()
    const hr = this.header ? this.header.getBoundingClientRect() : null
    // 头部隐藏（blank 会话）或无头部（0.1.2 无会话）时以根顶部为分栏上沿
    const top = hr && hr.height > 0 ? hr.bottom : rr.top
    this.geom = { left: rr.left, top, right: rr.right, bottom: rr.bottom }
  },

  applyMargin() {
    const viewArea = this.viewArea
    const g = this.geom
    const spec = this.spec
    if (!viewArea || !g || !spec) return
    const colW = g.right - g.left
    const rowH = g.bottom - g.top
    const hasLeft = !!spec.left
    const hasTop = !!(spec.top && spec.top.length > 0)
    const chatW = clamp(this.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
    // 会话内容宽 clamp(680px, …, 920px) 不随挤出的聊天列收缩 → 显式钉到挤出的列宽
    // （close/重锚定时原样恢复；0.1.1 上该 CSS 变量闲置，设置无害）
    if (this.root && this.root.isConnected) {
      this.root.style.setProperty('--dsh-chat-user-width', Math.round(chatW) + 'px')
    }
    const topH = hasTop
      ? clamp(this.topH, spec.topHeight?.min ?? 80, Math.max(spec.topHeight?.min ?? 80, rowH - BAR_H - 80))
      : 0
    const leftW = hasLeft
      ? clamp(this.leftW, spec.leftWidth?.min ?? 160, Math.max(spec.leftWidth?.min ?? 160, colW - 260))
      : 0
    const chatFull = spec.chatFullHeight === true
    const gap = Math.max(0, colW - chatW) + 'px'
    const mt = (BAR_H + (hasTop && !chatFull ? topH : 0)) + 'px'
    const chatLeft = !hasLeft && spec.chatSide === 'left'
    this.lastMarginLeft = hasLeft ? leftW + 'px' : (chatLeft ? '' : gap)
    this.lastMarginRight = hasLeft ? '' : (chatLeft ? gap : '')
    this.lastMarginTop = mt
    viewArea.style.marginLeft = this.lastMarginLeft
    viewArea.style.marginRight = this.lastMarginRight
    viewArea.style.marginTop = mt
  },

  setChatW(w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const colW = g.right - g.left
    const main = spec.main ?? []
    const minContent = main.reduce((a, p) => a + p.min, 0) + Math.max(0, main.length - 1) * GAP
    const hi = Math.max(spec.chatWidth.min, colW - minContent)
    this.chatW = clamp(Math.round(w), spec.chatWidth.min, hi)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  setTopH(h) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const rowH = g.bottom - g.top
    const lo = spec.topHeight?.min ?? 80
    const hi = Math.max(lo, rowH - BAR_H - 80)
    this.topH = clamp(Math.round(h), lo, hi)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  setLeftW(w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec || !spec.left) return
    const colW = g.right - g.left
    const lo = spec.leftWidth?.min ?? 160
    const hi = Math.max(lo, colW - 260)
    this.leftW = clamp(Math.round(w), lo, hi)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  setPaneW(i, w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const main = spec.main ?? []
    if (i < 0 || i >= main.length) return
    const colW = g.right - g.left
    const chatW = clamp(this.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
    const contentW = Math.max(0, colW - chatW)
    const othersMin = main.reduce((a, p, k) => a + (k === i ? 0 : p.min), 0)
    const lo = main[i].min
    const hi = Math.max(lo, contentW - othersMin - Math.max(0, main.length - 1) * GAP)
    const next = this.paneWs.slice()
    next[i] = clamp(Math.round(w), lo, hi)
    this.paneWs = next
    this.persist()
    this.notify()
  },

  setTopW(i, w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const top = spec.top ?? []
    if (i < 0 || i >= top.length) return
    const colW = g.right - g.left
    const othersMin = top.reduce((a, p, k) => a + (k === i ? 0 : p.min), 0)
    const lo = top[i].min
    const hi = Math.max(lo, colW - othersMin - Math.max(0, top.length - 1) * GAP)
    const next = this.topWs.slice()
    next[i] = clamp(Math.round(w), lo, hi)
    this.topWs = next
    this.persist()
    this.notify()
  },

  setPaneContent(row, i, content) {
    if (content) this.openTab(row, i, content)
  },

  lockPane(row, i, content) {
    const spec = this.spec
    if (!spec) return
    const tab: PaneTab = { id: 't' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), title: tabTitleOf(content), content, active: 0 }
    const mutate = (pane: SplitPane): SplitPane => ({ ...pane, content: null, tabs: [tab], active: 0 })
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  /** 更新指定标签页的内容（浏览器/动画窗地址栏回车时回写），并持久化到布局条目 */
  setTabContent(row, index, tabId, content) {
    const spec = this.spec
    if (!spec) return
    const edited = row === 'left' ? spec.left : row === 'top' ? spec.top?.[index] : spec.main[index]
    if (edited?.tabs?.some((t) => t.id === tabId)) this.onPaneContentEdited?.(spec.id, edited.id)
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = (pane.tabs ?? []).map((t) => (t.id === tabId ? { ...t, content, title: tabTitleOf(content) } : t))
      return { ...pane, tabs }
    }
    if (row === 'left') {
      if (spec.left && index === 0) this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (top[index]) { top[index] = mutate(top[index]); this.spec = { ...spec, top } }
    } else {
      const main = [...spec.main]
      if (main[index]) { main[index] = mutate(main[index]); this.spec = { ...spec, main } }
    }
    this.onSpecMutated?.(this.spec)
    this.notify()
  },

  openTab(row, i, content) {
    const spec = this.spec
    if (!spec) return
    const edited = row === 'left' ? spec.left : row === 'top' ? spec.top?.[i] : spec.main[i]
    if (edited) this.onPaneContentEdited?.(spec.id, edited.id)
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = [...(pane.tabs ?? [])]
      // 去重：同内容已有标签 → 直接激活
      const existing = tabs.findIndex((t) => sameContent(t.content, content))
      if (existing >= 0) return { ...pane, content: null, tabs, active: existing }
      const tab: PaneTab = { id: 't' + Date.now().toString(36), title: tabTitleOf(content), content }
      tabs.push(tab)
      return { ...pane, content: null, tabs, active: tabs.length - 1 }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  closeTab(row, i, tabId) {
    const spec = this.spec
    if (!spec) return
    const edited = row === 'left' ? spec.left : row === 'top' ? spec.top?.[i] : spec.main[i]
    if (edited?.tabs?.some((t) => t.id === tabId)) this.onPaneContentEdited?.(spec.id, edited.id)
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = (pane.tabs ?? []).filter((t) => t.id !== tabId)
      return { ...pane, tabs, active: 0 }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  moveTab(fromRow, fromI, tabId, toRow, toI) {
    const spec = this.spec
    if (!spec) return
    if (fromRow === toRow && fromI === toI) return
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const left = spec.left ? { ...spec.left } : null
    const arrOf = (row: PaneRow): SplitPane[] => (row === 'left' ? (left ? [left] : []) : row === 'top' ? top : main)
    const fromArr = arrOf(fromRow)
    const toArr = arrOf(toRow)
    const fromPane = fromArr[fromI]
    const toPane = toArr[toI]
    if (!fromPane || !toPane) return
    const tab = (fromPane.tabs ?? []).find((t) => t.id === tabId)
    if (!tab) return
    this.onPaneContentEdited?.(spec.id, fromPane.id)
    this.onPaneContentEdited?.(spec.id, toPane.id)
    const fromTabs = (fromPane.tabs ?? []).filter((t) => t.id !== tabId)
    const toTabs = [...(toPane.tabs ?? []), tab]
    const setPane = (row: PaneRow, i: number, pane: SplitPane) => {
      if (row === 'left') spec.left = pane
      else if (row === 'top') top[i] = pane
      else main[i] = pane
    }
    setPane(fromRow, fromI, { ...fromPane, tabs: fromTabs, active: 0 })
    setPane(toRow, toI, { ...toPane, tabs: toTabs, active: toTabs.length - 1 })
    this.spec = { ...spec, left: left ?? null, top: top.length > 0 ? top : null, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  /** 拆分窗格（VSCode 语义）：在指定行新增一个窗格，原窗格的标签从激活标签起对半搬过去。
   *  'right' = 同一行右侧插入；'down' = 挤到下一行（main 行内拆分时把后面的窗格整体后移）。
   *  返回新窗格下标；不改变标签内容本身（不复制、不新建）。 */
  splitPane(row: PaneRow, i: number, dir: 'right' | 'down'): number {
    const spec = this.spec
    if (!spec) return -1
    if (row === 'left') return -1            // 左列是整高单窗，不支持拆分
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const arr = row === 'top' ? top : main
    const src = arr[i]
    if (!src) return -1
    if (arr.length >= MAX_PANES_PER_ROW) return -1   // 上限 6：再宽就没法用了
    const tabs = src.tabs ?? []
    const active = src.active ?? 0
    // 从激活标签起对半：前一半留原窗，后一半去新窗。
    // 只有 0/1 个标签时原窗全留、新窗为空（不能把唯一标签搬走 —— 那等于「搬窗」不是「拆分」）。
    const cut = tabs.length > 1 ? Math.ceil(tabs.length / 2) : tabs.length
    const kept = tabs.slice(0, cut)
    const moved = tabs.slice(cut)
    const id = 'p' + Date.now().toString(36)
    const born: SplitPane = { id, title: paneTitleFor(arr, i), min: 200, tabs: moved, active: moved.length > 0 ? 0 : undefined }
    arr.splice(i + 1, 0, born)
    const patched: SplitPane = { ...src, tabs: kept, active: kept.length > 0 ? Math.min(active, kept.length - 1) : undefined }
    arr[i] = patched
    this.spec = row === 'top' ? { ...spec, top } : { ...spec, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
    return i + 1
  },

  /** 关闭窗格：先把它的标签整体搬到邻居窗格（不丢内容），再移除自身。
   *  至少保留一个内容窗；没有邻居可搬时把标签留在原窗（等价于只关闭拆分出来的新窗）。 */
  closePane(row: PaneRow, i: number): boolean {
    const spec = this.spec
    if (!spec) return false
    if (row === 'left') return false
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const arr = row === 'top' ? top : main
    if (arr.length <= 1) return false        // 最后一个窗格不许关（关了就什么都没有）
    const doomed = arr[i]
    if (!doomed) return false
    // 邻居优先级：右侧 → 左侧 → 任意存活窗格
    let target = i + 1 < arr.length ? i + 1 : i - 1 >= 0 ? i - 1 : -1
    if (target < 0) return false
    const tabs = doomed.tabs ?? []
    if (tabs.length > 0) {
      const dst = arr[target]
      const merged = [...(dst.tabs ?? []), ...tabs]
      arr[target] = { ...dst, tabs: merged, active: merged.length - 1 }
      this.onPaneContentEdited?.(spec.id, dst.id)
    }
    arr.splice(i, 1)
    this.spec = row === 'top' ? { ...spec, top } : { ...spec, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
    return true
  },

  setActiveTab(row, i, tabId) {
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  toggleCollapsed(row, i) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => ({ ...pane, collapsed: !pane.collapsed })
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  swapPanes(aRow, aI, bRow, bI) {
    const spec = this.spec
    if (!spec) return
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const left = spec.left ? { ...spec.left } : null
    const arrOf = (row: PaneRow): SplitPane[] => (row === 'left' ? (left ? [left] : []) : row === 'top' ? top : main)
    const setOf = (row: PaneRow, i: number, pane: SplitPane) => {
      if (row === 'left') spec.left = pane
      else if (row === 'top') top[i] = pane
      else main[i] = pane
    }
    const a = arrOf(aRow)[aI]
    const b = arrOf(bRow)[bI]
    if (!a || !b) return
    setOf(aRow, aI, b)
    setOf(bRow, bI, a)
    const wsOf = (row: PaneRow): number[] => (row === 'left' ? this.leftWs : row === 'top' ? this.topWs : this.paneWs)
    const setWs = (row: PaneRow, i: number, v: number) => {
      if (row === 'left') { const n = this.leftWs.slice(); n[i] = v; this.leftWs = n }
      else if (row === 'top') { const n = this.topWs.slice(); n[i] = v; this.topWs = n }
      else { const n = this.paneWs.slice(); n[i] = v; this.paneWs = n }
    }
    const aW = wsOf(aRow)[aI]
    const bW = wsOf(bRow)[bI]
    setWs(aRow, aI, bW)
    setWs(bRow, bI, aW)
    this.spec = { ...spec, left: left ?? null, top: top.length > 0 ? top : null, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  setChatSide(side) {
    const spec = this.spec
    if (!spec) return
    if (spec.left) return // 左列布局：聊天固定右下
    this.spec = { ...spec, chatSide: side }
    this.onSpecMutated?.(this.spec)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  persist() {
    if (!this.spec) return
    persistSaved(this.spec.id, { chatW: this.chatW, topH: this.topH, leftW: this.leftW, paneWs: this.paneWs, topWs: this.topWs, leftWs: this.leftWs })
  },

  close() {
    if (this.root && this.root.isConnected) {
      if (this.savedWidthVar) this.root.style.setProperty('--dsh-chat-user-width', this.savedWidthVar)
      else this.root.style.removeProperty('--dsh-chat-user-width')
    }
    if (this.viewArea) {
      this.viewArea.style.marginLeft = this.savedMarginLeft
      this.viewArea.style.marginRight = this.savedMarginRight
      this.viewArea.style.marginTop = this.savedMarginTop
    }
    this.observer?.disconnect()
    this.observer = null
    this.fallback?.disconnect()
    this.fallback = null
    this.yieldObserver?.disconnect()
    this.yieldObserver = null
    this.root = null
    this.header = null
    this.viewArea = null
    this.savedWidthVar = ''
    this.geom = null
    this.spec = null
    this.active = false
    this.notify()
  },

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },

  notify() {
    for (const fn of this.listeners) fn()
  },
}

/** 跨插件互操作桥：自带分栏实现的插件其浮层（.ta_split）出现 = 其引擎打开 → 本引擎让位。
 * 不改动对方插件代码，仅在 DOM 层观察其浮层挂载。 */
if (typeof document !== 'undefined' && document.body) {
  const taObserver = new MutationObserver(() => {
    if (!splitStore.active) return
    if (document.querySelector('.ta_split')) splitStore.close()
  })
  taObserver.observe(document.body, { childList: true, subtree: true })
}

/** 分配各窗宽度（最后一个拿余量） */
function allocate(panes: SplitPane[], ws: number[], total: number) {
  const out: { pane: SplitPane; left: number; width: number }[] = []
  const gapTotal = Math.max(0, panes.length - 1) * GAP
  const avail = Math.max(0, total - gapTotal)
  let x = 0
  panes.forEach((p, i) => {
    const w = i === panes.length - 1 ? Math.max(0, avail - x) : ws[i]
    out.push({ pane: p, left: x, width: w })
    x += w + GAP
  })
  return out
}

/** 通用分隔线拖拽（chat/top/pane/topPane） */
function makeDividerHandler(kind: 'left' | 'chat' | 'top' | 'pane' | 'topPane', index?: number) {
  return (e: any) => {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    try { target.setPointerCapture(e.pointerId) } catch {}
    const onMove = (ev: PointerEvent) => {
      const g = splitStore.geom
      if (!g) return
      if (kind === 'left') {
        splitStore.setLeftW(ev.clientX - g.left)
      } else if (kind === 'chat') {
        splitStore.setChatW(g.right - ev.clientX)
      } else if (kind === 'top') {
        splitStore.setTopH(ev.clientY - g.top - BAR_H)
      } else if (kind === 'pane' && index != null) {
        const prefix = splitStore.paneWs.slice(0, index).reduce((a, b) => a + b, 0) + index * GAP
        splitStore.setPaneW(index, ev.clientX - (g.left + prefix))
      } else if (kind === 'topPane' && index != null) {
        const prefix = splitStore.topWs.slice(0, index).reduce((a, b) => a + b, 0) + index * GAP
        splitStore.setTopW(index, ev.clientX - (g.left + prefix))
      }
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }
}

/** 浏览器内置窗：地址栏 + 前往；刷新统一在标签栏最左（重挂载 iframe，跨域也可靠） */
function BrowserPane(props: { row: PaneRow; index: number; tabId: string; content: SplitContent; reloadKey: number }) {
  const initial = props.content?.url || 'https://example.com'
  const [url, setUrl] = useState(initial)
  const [src, setSrc] = useState(initial)
  const go = () => {
    const u = url.trim()
    const ok = /^(\/|https?:\/\/)/i.test(u) ? u : 'about:blank'
    setSrc(ok)
    if (ok !== 'about:blank') {
      // 地址回写：刷新/重开布局时保持当前网址
      splitStore.setTabContent(props.row, props.index, props.tabId, { kind: 'builtin', type: 'browser', url: ok })
    }
  }
  return (
    <>
      <div className="dsh-wt_browserBar">
        <input
          className="dsh-wt_browserInput"
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
        />
        <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
      </div>
      {src === 'about:blank' ? (
        // 空态：地址不合法时明确说原因 + 下一步，不留白屏
        <div className="dsh-wt_paneWip">
          <span className="dsh-wt_paneWipIcon" aria-hidden>🌐</span>
          <span className="dsh-wt_paneWipText">{T('pane.browserBlank')}</span>
        </div>
      ) : (
        <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={src} title="browser" />
      )}
    </>
  )
}

/** iframe 内容标签（网页/站点产物）：刷新统一在标签栏最左（重挂载整页刷新，跨域可靠） */
function IframePane(props: { url: string; title?: string; reloadKey: number }) {
  return <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={props.url} title={props.title ?? ''} />
}

/** 动画播放窗：iframe 壳 + 地址栏（站内自带项目/场景列表、播放、画幅切换、导出等全部控件） */
function AnimPane(props: { row: PaneRow; index: number; tabId: string; content: SplitContent; reloadKey: number }) {
  const initial = props.content?.url || ''
  const [url, setUrl] = useState(initial)
  const [src, setSrc] = useState(initial || 'about:blank')
  const go = () => {
    const u = url.trim()
    const ok = /^(\/|https?:\/\/)/i.test(u) ? u : 'about:blank'
    setSrc(ok)
    if (ok !== 'about:blank') {
      splitStore.setTabContent(props.row, props.index, props.tabId, { kind: 'builtin', type: 'anim', url: ok })
    }
  }
  return (
    <>
      <div className="dsh-wt_browserBar">
        <input
          className="dsh-wt_browserInput"
          value={url}
          placeholder={T('pane.animUrlPh')}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
        />
        <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
      </div>
      <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={src} title="anim" />
    </>
  )
}

/** 主题图标（描边风格）：dark=月 / light=日 / system=电脑；主按钮与下拉共用 */
function ThemeIcon({ mode, size }: { mode: 'dark' | 'light' | 'system'; size?: number }) {
  const s = size ?? 18
  if (mode === 'dark') return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" /></svg>
  if (mode === 'light') return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="0.9" /><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
  return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><rect x="2" y="3.2" width="12" height="8.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="0.9" /><path d="M5.4 14.4h5.2M8 12v2.4" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
}

/** 两行滑杆图标（设置入口）：2 条轨道 + 2 个旋钮，描边风格 */
function SliderIcon({ size }: { size?: number }) {
  const s = size ?? 14
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 5.6h11M2.5 10.4h11" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10.4" cy="5.6" r="1.8" fill="currentColor" />
      <circle cx="5.8" cy="10.4" r="1.8" fill="currentColor" />
    </svg>
  )
}

/** HSL 数值普通输入框：始终为常规边框输入框，输入提交时自动钳制到 0..max */
function HslValInput(props: { value: number; max: number; min?: number; onCommit: (n: number) => void }) {
  const lo = props.min ?? 0
  const [draft, setDraft] = useState(String(props.value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(String(props.value)) }, [props.value, focused])
  const commit = () => {
    let n = parseInt(draft, 10)
    if (!Number.isFinite(n)) n = props.value
    n = Math.min(Math.max(n, lo), props.max)
    props.onCommit(n)
  }
  return (
    <input
      className="dsh-wt_hslInput"
      type="number"
      min={lo}
      max={props.max}
      value={focused ? draft : String(props.value)}
      onFocus={() => { setFocused(true); setDraft(String(props.value)) }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { setDraft(String(props.value)); (e.target as HTMLInputElement).blur() }
      }}
    />
  )
}

/** 纯色背景默认值（与主题关联）：深色 = 原深蓝黑 #0a0d13；浅色 = 白 #eef1f5；网格线由 --wt-grid 主题变量自动切换 */
const PLAIN_HSL_DARK = { h: -140, s: 31, l: 6 }
const PLAIN_HSL_LIGHT = { h: -146, s: 26, l: 95 }

/** 循环视频背景：首尾帧交叉渐变——双轨重叠过渡（尾帧淡出→头帧淡入），消除循环「卡一下」。
 *  两轨共用同一源；备用轨仅在交接窗口播放，其余时间暂停（解码负担仅 ~1.2s/循环）。 */
function ConsoleVideo(props: { src: string; style?: CSSProperties }) {
  const aRef = useRef<HTMLVideoElement | null>(null)
  const bRef = useRef<HTMLVideoElement | null>(null)
  const roleRef = useRef<'a' | 'b'>('a')
  const firedRef = useRef(false)
  useEffect(() => {
    const role = () => (roleRef.current === 'a' ? aRef.current : bRef.current)
    const spare = () => (roleRef.current === 'a' ? bRef.current : aRef.current)
    firedRef.current = false
    let raf = 0
    let stopped = false
    const onEnded = () => {
      const m = role()
      const s = spare()
      if (!m || !s) return
      // 主轨播完：备用轨已成为新主轨（淡入完成）；旧主轨复位为备用轨
      roleRef.current = roleRef.current === 'a' ? 'b' : 'a'
      firedRef.current = false
      try {
        m.currentTime = 0
        m.pause()
        m.style.opacity = '0'
        m.getAnimations().forEach((an) => an.cancel())
      } catch {}
      try {
        const nm = role()
        if (nm) nm.style.opacity = '1'
      } catch {}
    }
    const tick = () => {
      if (stopped) return
      const m = role()
      const s = spare()
      if (m && s && !m.paused && m.readyState >= 2 && !firedRef.current) {
        const d = m.duration
        if (Number.isFinite(d) && d > 0) {
          const fade = Math.min(2.0, Math.max(1.2, d * 0.18))
          if (m.currentTime >= Math.max(0, d - fade)) {
            firedRef.current = true
            try {
              try { s.currentTime = 0 } catch {}
              const startFade = () => {
                try {
                  try { m.getAnimations().forEach((an) => an.cancel()) } catch {}
                  try { s.getAnimations().forEach((an) => an.cancel()) } catch {}
                  s.play().catch(() => {})
                  s.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade * 1000, easing: 'linear', fill: 'forwards' })
                  m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade * 1000, easing: 'linear', fill: 'forwards' })
                } catch {}
              }
              if (s.readyState >= 2) startFade()
              else s.addEventListener('canplay', startFade, { once: true })
            } catch {}
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    aRef.current?.addEventListener('ended', onEnded)
    bRef.current?.addEventListener('ended', onEnded)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      aRef.current?.removeEventListener('ended', onEnded)
      bRef.current?.removeEventListener('ended', onEnded)
    }
  }, [])
  return (
    <>
      <video ref={aRef} className="dsh-wt_consoleMedia" src={props.src} muted autoPlay playsInline style={props.style} />
      <video ref={bRef} className="dsh-wt_consoleMedia" src={props.src} muted playsInline style={{ ...props.style, opacity: 0 }} />
    </>
  )
}

/** 控制室面板：项目卡片网格（每行 3 张、超出换行）；数据由工作台组装推送（纯读镜像）。
 *  主题：dark/light 直接生效；system = 跟随宿主 html 的 color-scheme（DSH 深色/白色/跟随系统都会反映到它） */
function ConsolePane() {
  const [, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [cols, setColsState] = useState<number>(() => splitEnv?.console?.getCols?.() ?? 3)
  const [shape, setShapeState] = useState<'square' | 'circle'>(() => splitEnv?.console?.getShape?.() ?? 'square')
  const [bg, setBgState] = useState<'plain' | 'glow' | 'photo'>(() => splitEnv?.console?.getBg?.() ?? 'glow')
  const [bgPhoto, setBgPhoto] = useState<string>('')
  const [photoId, setPhotoIdLocal] = useState<string>('')
  const [photoList, setPhotoList] = useState<{ id: string; kind: 'photo' | 'video'; url: string }[]>([])
  const [bgVideo, setBgVideo] = useState<string>('')
  const [photoGrid, setPhotoGridState] = useState<boolean>(() => splitEnv?.console?.getPhotoGrid?.() ?? true)
  const [gridOpacity, setGridOpacityState] = useState<number>(() => splitEnv?.console?.getGridOpacity?.() ?? 8)
  const [cardBlur, setCardBlurState] = useState<number>(() => splitEnv?.console?.getCardBlur?.() ?? 8)
  const [plainBlur, setPlainBlurState] = useState<number>(() => splitEnv?.console?.getPlainBlur?.() ?? 0)
  const [glowBlur, setGlowBlurState] = useState<number>(() => splitEnv?.console?.getGlowBlur?.() ?? 8)
  const [plainGrid, setPlainGridState] = useState<number>(() => splitEnv?.console?.getPlainGrid?.() ?? 5)
  const [glowGrid, setGlowGridState] = useState<number>(() => splitEnv?.console?.getGlowGrid?.() ?? 8)
  const [glowSpeed, setGlowSpeedState] = useState<number>(() => splitEnv?.console?.getGlowSpeed?.() ?? 50)
  const [annOpen, setAnnOpen] = useState(false)
  const [memOpen, setMemOpen] = useState(false)
  /** 编队日记：向 knowledge 仓 diary/ 追加一条（服务端 pull→append→commit→push） */
  const [diaryOpen, setDiaryOpen] = useState(false)
  const [diaryRepo, setDiaryRepo] = useState<string>(() => { try { return localStorage.getItem('dsh.worktable.diaryRepo.v1') ?? '' } catch { return '' } })
  const [diaryWho, setDiaryWho] = useState<string>(() => { try { return localStorage.getItem('dsh.worktable.diaryWho.v1') ?? 'dsh' } catch { return 'dsh' } })
  const [diaryText, setDiaryText] = useState('')
  const [diaryBusy, setDiaryBusy] = useState(false)
  const [diaryMsg, setDiaryMsg] = useState('')
  const sendDiary = async () => {
    const repo = diaryRepo.trim(); const text = diaryText.trim()
    if (!repo || !text || !diaryWho.trim()) { setDiaryMsg(T('diary.needFields')); return }
    setDiaryBusy(true); setDiaryMsg('')
    try {
      try { localStorage.setItem('dsh.worktable.diaryRepo.v1', repo); localStorage.setItem('dsh.worktable.diaryWho.v1', diaryWho.trim()) } catch {}
      const r = await fetch('/api/worktable/diary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, who: diaryWho.trim(), text }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d?.ok) throw new Error(d?.error ?? 'HTTP ' + r.status)
      setDiaryText('')
      setDiaryMsg(d.pushed ? T('diary.pushed', { file: String(d.file ?? '') }) : T('diary.localOnly', { file: String(d.file ?? '') }))
    } catch (e: any) { setDiaryMsg(String(e?.message ?? e)) } finally { setDiaryBusy(false) }
  }
  const [updStatus, setUpdStatus] = useState<UpdateStatus>(() => readCache().status)
  const [updInfo, setUpdInfo] = useState<UpdateInfo | null>(() => readCache().info)
  const [autoCheckOn, setAutoCheckOn] = useState<boolean>(() => getAutoCheck())
  const updBusyRef = useRef(false)
  const photoUrlRef = useRef<string>('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [bgEdit, setBgEdit] = useState<'plain' | 'glow' | 'photo' | null>(null)
  const [plainHsl, setPlainHslState] = useState<{ h: number; s: number; l: number }>(() => {
    const saved = splitEnv?.console?.getPlainHsl?.()
    if (saved) return saved
    return splitEnv?.console?.getTheme?.() === 'light' ? { ...PLAIN_HSL_LIGHT } : { ...PLAIN_HSL_DARK }
  })
  const [glowHsl, setGlowHslState] = useState<{ h: number; s: number; l: number }>(() => splitEnv?.console?.getGlowHsl?.() ?? { h: 0, s: 100, l: 100 })
  const [photoHsl, setPhotoHslState] = useState<{ h: number; s: number; l: number }>({ h: 0, s: 100, l: 100 })
  const gridRef = useRef<HTMLDivElement | null>(null)
  const firstRectsRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const onCols = (n: number) => {
    const grid = gridRef.current
    if (grid) {
      const rects = new Map<string, { x: number; y: number }>()
      grid.querySelectorAll('.dsh-wt_consoleCard').forEach((el) => {
        const key = (el as HTMLElement).dataset.flip ?? ''
        const r = el.getBoundingClientRect()
        rects.set(key, { x: r.left, y: r.top })
      })
      firstRectsRef.current = rects
    }
    setColsState(n)
    splitEnv?.console?.setCols?.(n)
  }
  const onShape = (s: 'square' | 'circle') => {
    setShapeState(s)
    splitEnv?.console?.setShape?.(s)
  }
  /** 选择本地图片文件并入库 */
  const pickPhotoFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,video/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      onFilePhoto(file)
    }
    input.click()
  }
  /** 新增媒体（照片/视频）：原始 Blob 存 IndexedDB（零压缩），显示用对象 URL；自动设为当前 */
  const onFilePhoto = async (file: Blob) => {
    let id = ''
    let url = ''
    let kind: 'photo' | 'video' = file.type && file.type.indexOf('video/') === 0 ? 'video' : 'photo'
    const rec = await (splitEnv?.console?.addPhoto?.(file) ?? Promise.resolve(null)).catch(() => null)
    if (rec) { id = rec.id; url = rec.url; kind = rec.kind } else {
      url = URL.createObjectURL(file)
    }
    photoUrlRef.current = url
    setPhotoIdLocal(id)
    if (id) setPhotoList((prev) => [{ id, kind, url }, ...prev])
    if (kind === 'video') { setBgPhoto(''); setBgVideo(url) } else { setBgVideo(''); setBgPhoto(url) }
    setBgState('photo')
    splitEnv?.console?.setBg?.('photo')
  }
  /** 删除一条媒体：当前使用的那条被删 → 切到最新一条；删光 → 回到流光背景 */
  const removePhotoById = async (p: { id: string; kind: 'photo' | 'video'; url: string }) => {
    try { await splitEnv?.console?.removePhoto?.(p.id) } catch {}
    try { URL.revokeObjectURL(p.url) } catch {}
    const nextList = photoList.filter((x) => x.id !== p.id)
    setPhotoList(nextList)
    if (photoId === p.id) {
      const next = nextList[0] ?? null
      if (next) {
        setPhotoIdLocal(next.id)
        splitEnv?.console?.setPhotoId?.(next.id)
        photoUrlRef.current = next.url
        setBgVideo(next.kind === 'video' ? next.url : '')
        setBgPhoto(next.kind === 'video' ? '' : next.url)
        setBgState('photo')
        splitEnv?.console?.setBg?.('photo')
      } else {
        setPhotoIdLocal('')
        photoUrlRef.current = ''
        setBgPhoto('')
        setBgVideo('')
        setBgState('glow')
        splitEnv?.console?.setBg?.('glow')
      }
    }
  }
  const togglePhotoGrid = () => {
    const next = !photoGrid
    setPhotoGridState(next)
    splitEnv?.console?.setPhotoGrid?.(next)
  }
  const onGridOpacity = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 30)
    setGridOpacityState(v)
    splitEnv?.console?.setGridOpacity?.(v)
  }
  const onCardBlur = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 20)
    setCardBlurState(v)
    splitEnv?.console?.setCardBlur?.(v)
  }
  const onModeBlur = (kind: 'plain' | 'glow' | 'photo', n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 20)
    if (kind === 'plain') { setPlainBlurState(v); splitEnv?.console?.setPlainBlur?.(v) }
    else if (kind === 'glow') { setGlowBlurState(v); splitEnv?.console?.setGlowBlur?.(v) }
    else { setCardBlurState(v); splitEnv?.console?.setCardBlur?.(v) }
  }
  const onModeGrid = (kind: 'plain' | 'glow', n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 30)
    if (kind === 'plain') { setPlainGridState(v); splitEnv?.console?.setPlainGrid?.(v) }
    else { setGlowGridState(v); splitEnv?.console?.setGlowGrid?.(v) }
  }
  const onGlowSpeed = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 100)
    setGlowSpeedState(v)
    splitEnv?.console?.setGlowSpeed?.(v)
  }
  const runUpdateCheck = async (force: boolean) => {
    if (updBusyRef.current) return
    updBusyRef.current = true
    setUpdStatus('checking')
    try {
      const r = await checkUpdate(force)
      setUpdStatus(r.status)
      setUpdInfo(r.info)
    } finally {
      updBusyRef.current = false
    }
  }
  const [updCopied, setUpdCopied] = useState(false)
  const onCopyUpgrade = async () => {
    const ok = await copyTextSafe(UPGRADE_AI)
    if (ok) { setUpdCopied(true); window.setTimeout(() => setUpdCopied(false), 2200) }
  }
  const onSkipVersion = () => {
    if (updInfo) { setSkipVersion(updInfo.latest); setUpdInfo(null); setUpdStatus('uptodate') }
  }
  const onAutoCheckToggle = () => {
    const next = !autoCheckOn
    setAutoCheckOn(next)
    storeAutoCheck(next)
    if (next) void runUpdateCheck(false)
  }
  /** 抓手拖拽排序：按住抓手上下移动 → 行实时重排，松手持久化 */
  const dragRowRef = useRef<string | null>(null)
  const dragFlipRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const lastTargetRef = useRef<number>(-1)
  const [dragRowId, setDragRowId] = useState<string | null>(null)
  // FLIP：落位提交后，其他行从旧位置平滑让位（260ms 缓出）
  useLayoutEffect(() => {
    const first = dragFlipRef.current
    if (!first) return
    dragFlipRef.current = null
    document.querySelectorAll<HTMLElement>('.dsh-wt_photoRow').forEach((el) => {
      const key = el.dataset.rid ?? ''
      const f = first.get(key)
      if (!f) return
      const r = el.getBoundingClientRect()
      const dx = f.x - r.left
      const dy = f.y - r.top
      if (dx || dy) el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.25,.6,.3,1)' })
    })
  }, [photoList])
  const onHandleDown = (id: string, e: { button: number; preventDefault: () => void; stopPropagation: () => void }) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRowRef.current = id
    lastTargetRef.current = photoList.findIndex((x) => x.id === id)
    setDragRowId(id)
    const onMove = (ev: PointerEvent) => {
      if (dragRowRef.current !== id) return
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.dsh-wt_photoRow'))
      if (rows.length === 0) return
      // 槽位制：按固定行高算最近槽位；边界 ±0.12 行高为死区，未决定性越过前不切换
      const first = rows[0].getBoundingClientRect()
      const h = first.height
      const rel = (ev.clientY - first.top) / h
      let t = Math.max(0, Math.min(rows.length - 1, Math.floor(rel + 0.5)))
      const frac = rel - Math.floor(rel)
      if (Math.abs(frac - 0.5) < 0.12) t = lastTargetRef.current
      if (t === lastTargetRef.current) return
      const from = photoList.findIndex((x) => x.id === id)
      if (from < 0) return
      const rects = new Map<string, { x: number; y: number }>()
      rows.forEach((el) => { const k = el.dataset.rid ?? ''; const r = el.getBoundingClientRect(); rects.set(k, { x: r.left, y: r.top }) })
      const next = [...photoList]
      const moved = next.splice(from, 1)[0]
      const to = Math.max(0, Math.min(t, next.length))
      next.splice(to, 0, moved)
      dragFlipRef.current = rects
      setPhotoList(next)
      lastTargetRef.current = t
    }
    const onUp = () => {
      dragRowRef.current = null
      setDragRowId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const ids = photoList.map((x) => x.id)
      void splitEnv?.console?.reorderPhotos?.(ids).catch(() => {})
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  /** 在媒体库中选中某条 */
  const selectPhoto = (p: { id: string; kind: 'photo' | 'video'; url: string }) => {
    setPhotoIdLocal(p.id)
    splitEnv?.console?.setPhotoId?.(p.id)
    photoUrlRef.current = p.url
    if (p.kind === 'video') { setBgPhoto(''); setBgVideo(p.url) } else { setBgVideo(''); setBgPhoto(p.url) }
    setBgState('photo')
    splitEnv?.console?.setBg?.('photo')
  }
  const onBg = (m: 'plain' | 'glow' | 'photo') => {
    if (m === 'photo') {
      // 直接切换到当前媒体；没有媒体时才进入二级菜单引导上传
      if (photoList.length === 0) { setBgEdit('photo'); return }
      setBgState('photo')
      splitEnv?.console?.setBg?.('photo')
      return
    }
    setBgState(m)
    splitEnv?.console?.setBg?.(m)
  }
  const editHsl = (kind: 'plain' | 'glow' | 'photo', patch: Partial<{ h: number; s: number; l: number }>) => {
    if (kind === 'plain') {
      const next = { ...plainHsl, ...patch }
      setPlainHslState(next)
      splitEnv?.console?.setPlainHsl?.(next)
    } else if (kind === 'glow') {
      const next = { ...glowHsl, ...patch }
      setGlowHslState(next)
      splitEnv?.console?.setGlowHsl?.(next)
    } else {
      const next = { ...photoHsl, ...patch }
      setPhotoHslState(next)
      if (photoId) splitEnv?.console?.setPhotoHsl?.(photoId, next)
    }
  }
  const resetHsl = (kind: 'plain' | 'glow' | 'photo') => {
    // 恢复初始：连同贴片模糊(B)/网格不透明度(T)一起复位（纯色 B=0，流光/自定义 B=8）
    const blurDef = kind === 'plain' ? 0 : 8
    if (kind === 'plain') {
      setPlainBlurState(blurDef); splitEnv?.console?.setPlainBlur?.(blurDef)
      setPlainGridState(5); splitEnv?.console?.setPlainGrid?.(5)
    } else if (kind === 'glow') {
      setGlowBlurState(blurDef); splitEnv?.console?.setGlowBlur?.(blurDef)
      setGlowGridState(8); splitEnv?.console?.setGlowGrid?.(8)
      setGlowSpeedState(50); splitEnv?.console?.setGlowSpeed?.(50)
    } else {
      setCardBlurState(blurDef); splitEnv?.console?.setCardBlur?.(blurDef)
      setGridOpacityState(8); splitEnv?.console?.setGridOpacity?.(8)
    }
    if (kind === 'plain') {
      const def = resolvedTheme === 'light' ? { ...PLAIN_HSL_LIGHT } : { ...PLAIN_HSL_DARK }
      setPlainHslState(def)
      splitEnv?.console?.setPlainHsl?.(def)
    } else if (kind === 'glow') {
      setGlowHslState({ h: 0, s: 100, l: 100 })
      splitEnv?.console?.setGlowHsl?.({ h: 0, s: 100, l: 100 })
    } else {
      setPhotoHslState({ h: 0, s: 100, l: 100 })
      if (photoId) splitEnv?.console?.setPhotoHsl?.(photoId, { h: 0, s: 100, l: 100 })
      // 照片网格线开关一并复位为默认「开」
      setPhotoGridState(true); splitEnv?.console?.setPhotoGrid?.(true)
    }
  }
  useLayoutEffect(() => {
    const first = firstRectsRef.current
    if (!first) return
    const grid = gridRef.current
    if (!grid) return
    grid.querySelectorAll('.dsh-wt_consoleCard').forEach((el) => {
      const key = (el as HTMLElement).dataset.flip ?? ''
      const f = first.get(key)
      if (!f) return
      const r = el.getBoundingClientRect()
      const dx = f.x - r.left
      const dy = f.y - r.top
      if (dx || dy) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.22,.61,.36,1)' })
      }
    })
    firstRectsRef.current = null
  }, [cols])
  const [themeMode, setThemeMode] = useState<'dark' | 'light' | 'system'>(() => splitEnv?.console?.getTheme?.() ?? 'system')
  const [sysDark, setSysDark] = useState(() => {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return true }
  })
  useEffect(() => {
    const env = splitEnv?.console
    if (!env) return
    const bump = () => { setTick((t) => t + 1); setThemeMode(env.getTheme?.() ?? 'system') }
    const un = env.subscribe(bump)
    bump()
    return un
  }, [])
  // 跟随系统：监听 OS 深浅切换（仅 themeMode==='system' 时影响渲染）
  useEffect(() => {
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch {}
    if (!mq) return
    const f = (e: any) => setSysDark(!!e?.matches)
    try { mq.addEventListener('change', f) } catch { try { (mq as any).addListener(f) } catch {} }
    return () => { try { mq.removeEventListener('change', f) } catch { try { (mq as any).removeListener(f) } catch {} } }
  }, [])
  // 打开控制室 = 预热所有绑定会话的最近消息（冷会话走宿主 history 只读通道）
  useEffect(() => {
    splitEnv?.console?.refreshPreviews?.()
  }, [])
  // 自动检查更新（节流一天；手动按钮始终 force）
  useEffect(() => { if (getAutoCheck()) void runUpdateCheck(false) }, [])
  // 背景照片库：IndexedDB 异步加载记录 → 对象 URL；无记录则空
  useEffect(() => {
    let alive = true
    splitEnv?.console?.getPhotoLib?.().then((lib) => {
      if (!alive) return
      setPhotoList(lib.list)
      const active = lib.list.find((p) => p.id === lib.activeId) ?? lib.list[0] ?? null
      if (active) {
        setPhotoIdLocal(active.id)
        photoUrlRef.current = active.url
        setBgVideo(active.kind === 'video' ? active.url : '')
        setBgPhoto(active.kind === 'video' ? '' : active.url)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  // 当前照片切换 → 载入该照片记住的 HSL 调节值
  useEffect(() => {
    if (!photoId) return
    setPhotoHslState(splitEnv?.console?.getPhotoHsl?.(photoId) ?? { h: 0, s: 100, l: 100 })
  }, [photoId])
  // 面板卸载时释放对象 URL
  useEffect(() => () => { if (photoUrlRef.current) { try { URL.revokeObjectURL(photoUrlRef.current) } catch {} } }, [])
  // 运行时长的分钟级刷新：每秒重渲染一次；仅当控制室窗可见时才刷新（隐藏的保活工作区不重渲染，减少切项目卡顿）
  useEffect(() => {
    const iv = window.setInterval(() => {
      const g = gridRef.current
      if (g && g.offsetWidth > 0 && g.offsetHeight > 0) setNow(Date.now())
    }, 1000)
    return () => window.clearInterval(iv)
  }, [])
  void now
  const env = splitEnv?.console
  const cards = env ? env.getCards() : []
  const resolvedTheme: 'dark' | 'light' = (() => {
    if (themeMode !== 'system') return themeMode
    try {
      const cs = getComputedStyle(document.documentElement).colorScheme || ''
      if (cs.includes('dark') && !cs.includes('light')) return 'dark'
      if (cs.includes('light') && !cs.includes('dark')) return 'light'
    } catch {}
    return sysDark ? 'dark' : 'light'
  })()
  const setTheme = (th: 'dark' | 'light' | 'system') => { setThemeMode(th); env?.setTheme?.(th) }
  // 主题联动：切换主题时，若纯色还是另一主题的默认值 → 自动跟随新主题默认；自定义过则保持
  const prevPlainThemeRef = useRef<'dark' | 'light' | null>(null)
  useEffect(() => {
    const prev = prevPlainThemeRef.current
    prevPlainThemeRef.current = resolvedTheme
    if (!prev || prev === resolvedTheme) return
    const isDarkDef = plainHsl.h === PLAIN_HSL_DARK.h && plainHsl.s === PLAIN_HSL_DARK.s && plainHsl.l === PLAIN_HSL_DARK.l
    const isLightDef = plainHsl.h === PLAIN_HSL_LIGHT.h && plainHsl.s === PLAIN_HSL_LIGHT.s && plainHsl.l === PLAIN_HSL_LIGHT.l
    const next = resolvedTheme === 'light' && isDarkDef ? { ...PLAIN_HSL_LIGHT }
      : resolvedTheme === 'dark' && isLightDef ? { ...PLAIN_HSL_DARK } : null
    if (next) {
      setPlainHslState(next)
      splitEnv?.console?.setPlainHsl?.(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme])
  const fmtDur = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = s % 60
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') : m + ':' + String(ss).padStart(2, '0')
  }
  const statusLabel: Record<string, string> = { idle: T('console.idle'), busy: T('console.busy'), need: T('console.need'), done: T('console.done') }
  const themeOpts: { mode: 'dark' | 'light' | 'system'; key: string }[] = [
    { mode: 'dark', key: 'console.themeDark' },
    { mode: 'light', key: 'console.themeLight' },
    { mode: 'system', key: 'console.themeSystem' },
  ]
  return (
    <div className="dsh-wt_console" data-wt-theme={resolvedTheme} data-wt-shape={shape} data-wt-bg={bg} data-wt-grid={bg === 'photo' && !photoGrid ? 'off' : 'on'} style={{ ...(bg === 'plain' ? { ['--wt-bg' as any]: 'hsl(' + plainHsl.h + ', ' + plainHsl.s + '%, ' + plainHsl.l + '%)', ['--wt-gridPlain' as any]: 'rgba(255,255,255,' + (plainGrid / 100) + ')', ['--wt-gridPlainLight' as any]: 'rgba(27,31,36,' + (plainGrid / 100) + ')' } : {}), ...(bg === 'glow' ? { ['--wt-gridGlow' as any]: 'rgba(255,255,255,' + (glowGrid / 100) + ')', ['--wt-gridGlowLight' as any]: 'rgba(27,31,36,' + (glowGrid / 100) + ')', ['--wt-glowScale' as any]: glowSpeed === 0 ? '100000000' : String(50 / glowSpeed) } : {}), ...(bg === 'photo' ? { ['--wt-gridPhoto' as any]: 'rgba(255,255,255,' + (gridOpacity / 100) + ')' } : {}), ['--wt-cardBlur' as any]: (bg === 'plain' ? plainBlur : bg === 'glow' ? glowBlur : cardBlur) + 'px' }}>
      <span className="dsh-wt_consoleBg" aria-hidden style={bg === 'glow' && (glowHsl.h !== 0 || glowHsl.s !== 100 || glowHsl.l !== 100) ? { filter: 'hue-rotate(' + glowHsl.h + 'deg) saturate(' + glowHsl.s + '%) brightness(' + glowHsl.l + '%)' } : undefined}>
        {bg === 'photo' && (bgVideo
          ? <ConsoleVideo src={bgVideo} style={photoHsl.h !== 0 || photoHsl.s !== 100 || photoHsl.l !== 100 ? { filter: 'hue-rotate(' + photoHsl.h + 'deg) saturate(' + photoHsl.s + '%) brightness(' + photoHsl.l + '%)' } : undefined} />
          : bgPhoto ? <img className="dsh-wt_consoleMedia" src={bgPhoto} alt="" style={photoHsl.h !== 0 || photoHsl.s !== 100 || photoHsl.l !== 100 ? { filter: 'hue-rotate(' + photoHsl.h + 'deg) saturate(' + photoHsl.s + '%) brightness(' + photoHsl.l + '%)' } : undefined} /> : null)}
        {bg === 'glow' && (<><i className="dsh-wt_blob dsh-wt_blob1" /><i className="dsh-wt_blob dsh-wt_blob2" /><i className="dsh-wt_blob dsh-wt_blob3" /><i className="dsh-wt_blob dsh-wt_blob4" /></>)}</span>
      {openMenu !== null && <div className="dsh-wt_dropMask" onClick={() => setOpenMenu(null)} />}
      <div className="dsh-wt_consoleScroll">
        {memOpen ? (
          <MemoryPanel
            folder={env?.getProjectFolder?.() ?? ''}
            projectName={env?.getProjectName?.() ?? T('console.name')}
            onClose={() => setMemOpen(false)}
          />
        ) : diaryOpen ? (
          <div className="dsh-wt_announceCtr">
            <div className="dsh-wt_announce dsh-wt_diaryCtr">
              <div className="dsh-wt_announceHead">
                <span className="dsh-wt_announceVer">📔 {T('diary.title')}</span>
                <button type="button" className="dsh-wt_memClose" onClick={() => setDiaryOpen(false)} aria-label={T('mem.cancel')}>✕</button>
              </div>
              <div className="dsh-wt_customRow">
                <span className="dsh-wt_customLabel">{T('diary.repo')}</span>
                <input className="dsh-wt_customPathInput" placeholder="F:\\AI\\工作区\\knowledge" value={diaryRepo} onChange={(e) => { setDiaryRepo(e.target.value); setDiaryMsg('') }} />
              </div>
              <div className="dsh-wt_customRow">
                <span className="dsh-wt_customLabel">{T('diary.who')}</span>
                <input className="dsh-wt_customPathInput" style={{ maxWidth: 160 }} value={diaryWho} onChange={(e) => setDiaryWho(e.target.value)} />
              </div>
              <textarea className="dsh-wt_diaryText" placeholder={T('diary.ph')} value={diaryText} onChange={(e) => { setDiaryText(e.target.value); setDiaryMsg('') }} rows={6} />
              <button type="button" className="dsh-wt_customSend" disabled={diaryBusy || !diaryRepo.trim() || !diaryText.trim() || !diaryWho.trim()} onClick={() => void sendDiary()}>{diaryBusy ? '…' : T('diary.send')}</button>
              {diaryMsg && <p className="dsh-wt_diaryMsg">{diaryMsg}</p>}
              <p className="dsh-wt_memHint">{T('diary.hint')}</p>
            </div>
          </div>
        ) : annOpen ? (
          <div className="dsh-wt_announceCtr">
          <div className="dsh-wt_announce">
            <div className="dsh-wt_announceHead">
              <span className="dsh-wt_announceVer">{T('annot.curVer')} v{LOCAL_VERSION}</span>
              <button type="button" className="dsh-wt_announceBtn" disabled={updStatus === 'checking'} onClick={() => runUpdateCheck(true)}>{updStatus === 'checking' ? T('annot.checking') : T('annot.checkNow')}</button>
              <span className="dsh-wt_announceAuto">{T('annot.autoCheck')}</span>
              <button type="button" className={'dsh-wt_switch' + (autoCheckOn ? ' dsh-wt_switchOn' : '')} aria-pressed={autoCheckOn} aria-label={T('annot.autoCheck')} onClick={onAutoCheckToggle}><span className="dsh-wt_switchKnob" /></button>
            </div>
            {updInfo && (
              <div className="dsh-wt_announceUpdate">
                <span className="dsh-wt_announceNewVer">{T('annot.newVer')} v{updInfo.latest}</span>
                <button type="button" className={'dsh-wt_announceUpg' + (updCopied ? ' dsh-wt_announceUpgOk' : '')} onClick={onCopyUpgrade}>{updCopied ? T('annot.copied') : T('annot.copyUpgrade')}</button>
                <button type="button" className="dsh-wt_announceSkip dsh-wt_announceSkipGo" onClick={() => { try { window.open(updInfo.url, '_blank') } catch {} }}>{T('annot.gotoRelease')}</button>
                <button type="button" className="dsh-wt_announceSkip" onClick={onSkipVersion}>{T('annot.skipVer')}</button>
                <div className="dsh-wt_announceHow">{T('annot.howUpdate')}</div>
              </div>
            )}
            {updStatus === 'failed' && <div className="dsh-wt_announceStatus">{T('annot.checkFail')}</div>}
            {updStatus === 'uptodate' && !updInfo && <div className="dsh-wt_announceStatus">{T('annot.latest')}</div>}
            <div className="dsh-wt_announceBody">{CHANGELOG_V030}</div>
          </div>
          </div>
        ) : (
        <div ref={gridRef} className="dsh-wt_consoleGrid" style={{ ['--wt-cols' as any]: cols }}>
        {cards.map((c) => (
          <div
            key={c.id}
            data-flip={c.id}
            role={c.self ? undefined : 'button'}
            tabIndex={c.self ? -1 : 0}
            className={'dsh-wt_consoleCard' + (c.self ? ' dsh-wt_consoleCardSelf' : '')
              + (c.status === 'busy' ? ' dsh-wt_consoleCard-busy' : '')
              + (c.glow && c.status === 'done' ? ' dsh-wt_consoleCard-glowDone' : '')
              + (c.glow && c.status === 'need' ? ' dsh-wt_consoleCard-glowNeed' : '')}
            title={c.name}
            onClick={() => {
              if (c.self || !env) return
              if (c.glow) env.onAck?.(c.id) // 点发光卡片：先确认熄光，再进入
              env.onOpen(c.id)
            }}
          >
            <div className="dsh-wt_consoleCardHead">
              <span className="dsh-wt_consoleIcon" aria-hidden>{c.icon}</span>
              <span className="dsh-wt_consoleName">{c.name}</span>
            </div>
            <div className="dsh-wt_consoleDivider" aria-hidden />
            <div className="dsh-wt_consoleStatusRow">
              <span className={'dsh-wt_consoleStatus dsh-wt_consoleStatus-' + c.status}>{statusLabel[c.status]}</span>
              {c.runtimeMs != null && <span className="dsh-wt_consoleRuntime">{fmtDur(c.runtimeMs)}</span>}
            </div>
            {c.status === 'busy' && <span className="dsh-wt_consoleSweep" aria-hidden />}
            <div className={'dsh-wt_consolePreview' + (c.preview ? '' : ' dsh-wt_consolePreviewNone')} title={c.preview}>
              {c.preview || (c.bound ? T('console.noPreview') : T('console.unboundShort'))}
            </div>
          </div>
        ))}
        {/* 创建卡片：永远最后一位；点击 = 侧栏工作台「添加项目」同款流程 */}
        <div
          role="button"
          tabIndex={0}
          className="dsh-wt_consoleCard dsh-wt_consoleAdd"
          title={T('console.addProject')}
          onClick={() => env?.onAdd?.()}
        >
          <span className="dsh-wt_consoleAddPlus" aria-hidden>＋</span>
          <span className="dsh-wt_consoleAddLabel">{T('console.addProject')}</span>
        </div>
        {cards.length === 0 && <div className="dsh-wt_consoleEmpty">{T('console.empty')}</div>}
        </div>
        )}
      </div>
      <div className="dsh-wt_consoleDockWrap">
        <div className="dsh-wt_consoleDock">
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'theme' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.themeLabel')} aria-label={T('console.themeLabel')} onClick={() => setOpenMenu(openMenu === 'theme' ? null : 'theme')}><ThemeIcon mode={themeMode} /></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'shape' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.shapeLabel')} aria-label={T('console.shapeLabel')} onClick={() => setOpenMenu(openMenu === 'shape' ? null : 'shape')}><svg width="20" height="20" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="2.2" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="0.9" /><circle cx="10.6" cy="10.6" r="3.8" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'bg' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.bgLabel')} aria-label={T('console.bgLabel')} onClick={() => { setOpenMenu(openMenu === 'bg' ? null : 'bg'); setBgEdit(null) }}><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="0.9" /><circle cx="5.9" cy="6.7" r="1.05" fill="none" stroke="currentColor" strokeWidth="0.8" /><path d="M3.4 11.4l3-3 2.3 2.3 1.9-1.9 3 2.6" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'cols' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.colsLabel')} aria-label={T('console.colsLabel')} onClick={() => setOpenMenu(openMenu === 'cols' ? null : 'cols')}><svg width="20" height="20" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="6.65" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="11.1" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (memOpen ? ' dsh-wt_dockBtnOn' : '')} title={T('mem.title')} aria-label={T('mem.title')} onClick={() => { setOpenMenu(null); setAnnOpen(false); setMemOpen((v) => !v) }}><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><path d="M8 2.2c2.6 0 4.4 1.9 4.4 4.3 0 2.1-1.4 3.2-2.6 3.7-.5.2-.7.5-.7 1v.5H6.9v-.5c0-.5-.2-.8-.7-1C5 9.7 3.6 8.6 3.6 6.5 3.6 4.1 5.4 2.2 8 2.2Z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" /><path d="M6.9 13.1h2.2" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (diaryOpen ? ' dsh-wt_dockBtnOn' : '')} title={T('diary.title')} aria-label={T('diary.title')} onClick={() => { setOpenMenu(null); setAnnOpen(false); setMemOpen(false); setDiaryOpen((v) => !v) }}><span style={{ fontSize: 15, lineHeight: '18px' }} aria-hidden>📔</span></button>
          <button type="button" className={'dsh-wt_dockBtn' + (annOpen ? ' dsh-wt_dockBtnOn' : '')} title={T('annot.updateTitle')} aria-label={T('annot.updateTitle')} onClick={() => { setOpenMenu(null); setMemOpen(false); setAnnOpen((v) => !v) }}><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><path d="M2.6 7c0-2.9 2.4-4.9 5.4-4.9s5.4 2 5.4 4.9v2.9l1.2 1.7H1.4l1.2-1.7z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" /><path d="M6.2 12.9c.3.7 1 1.2 1.8 1.2s1.5-.5 1.8-1.2" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>{updInfo && <span className="dsh-wt_dockBadge" aria-hidden />}</button>
        </div>
        {openMenu === 'theme' && (
          <div className="dsh-wt_drop">
            {themeOpts.map((o) => (
              <button key={o.mode} type="button" className={'dsh-wt_dropItem' + (themeMode === o.mode ? ' dsh-wt_dropItemOn' : '')} onClick={() => setTheme(o.mode)}><ThemeIcon mode={o.mode} size={13} />{T(o.key)}</button>
            ))}
          </div>
        )}
        {openMenu === 'shape' && (
          <div className="dsh-wt_drop">
            <button type="button" className={'dsh-wt_dropItem' + (shape === 'square' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onShape('square')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="4" y="4" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>{T('console.shapeSquare')}</button>
            <button type="button" className={'dsh-wt_dropItem' + (shape === 'circle' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onShape('circle')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>{T('console.shapeCircle')}</button>
          </div>
        )}
        {openMenu === 'bg' && (
          bgEdit === null ? (
            <div className="dsh-wt_drop">
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'plain' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('plain')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgPlain')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('plain')}><SliderIcon /></button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'glow' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('glow')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><path d="M2.4 5.6c2-1.5 3.9-1.5 5.6 0 1.9 1.6 3.6 1.6 5.6 0M2.4 10.4c2-1.5 3.9-1.5 5.6 0 1.9 1.6 3.6 1.6 5.6 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>{T('console.bgGlow')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('glow')}><SliderIcon /></button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'photo' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('photo')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="5.8" cy="6.6" r="1.1" fill="currentColor" /><path d="M3.2 11.2l2.8-2.8 2.2 2.2 1.8-1.8 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgCustom')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('photo')}><SliderIcon /></button>
              </div>
            </div>
          ) : (
            <div className={'dsh-wt_drop' + (bgEdit === 'photo' ? ' dsh-wt_dropWide' : '')}>
              <div className="dsh-wt_hslHead">
                <button type="button" className="dsh-wt_hslBack" title={T('console.bgEditBack')} aria-label={T('console.bgEditBack')} onClick={() => setBgEdit(null)}><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M10.2 3.2 5.4 8l4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                <span className="dsh-wt_hslTitle">{bgEdit === 'plain' ? T('console.bgEditPlain') : bgEdit === 'glow' ? T('console.bgEditGlow') : T('console.bgEditPhoto')}</span>
              </div>
              {bgEdit === 'photo' && (
                <>
                  <div className="dsh-wt_dropRow">
                    <button type="button" className="dsh-wt_dropItem" onClick={pickPhotoFile}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="5.8" cy="6.6" r="1.1" fill="currentColor" /><path d="M3.2 11.2l2.8-2.8 2.2 2.2 1.8-1.8 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgPhoto')}</button>
                    <div className="dsh-wt_gridHalf">
                      <span className="dsh-wt_gridLabel">{T('console.bgGridLabel')}</span>
                      <button type="button" className={'dsh-wt_switch' + (photoGrid ? ' dsh-wt_switchOn' : '')} aria-pressed={photoGrid} aria-label={T('console.bgGridLabel')} onClick={togglePhotoGrid}><span className="dsh-wt_switchKnob" /></button>
                    </div>
                  </div>
                  {photoList.length > 0 ? (
                    photoList.slice(0, 4).map((p) => (
                      <div key={p.id} data-rid={p.id} className={'dsh-wt_dropRow dsh-wt_photoRow' + (photoId === p.id ? ' dsh-wt_photoRowOn' : '')} onClick={() => selectPhoto(p)}>
                        <span className="dsh-wt_thumbWrap">
                          {p.kind === 'video'
                            ? <video className="dsh-wt_photoThumb" src={p.url} muted playsInline preload="metadata" />
                            : <img className="dsh-wt_photoThumb" src={p.url} alt="" />}
                          <span className="dsh-wt_thumbBadge" aria-hidden>{p.kind === 'video'
                            ? <svg width="8" height="8" viewBox="0 0 16 16"><path d="M4.5 3.8l8 4.2-8 4.2z" fill="currentColor" /></svg>
                            : <svg width="8" height="8" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M3.4 11l2.6-2.6 2.1 2.1 1.7-1.7 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}</span>
                        </span>
                        <span className="dsh-wt_photoName">{photoId === p.id ? T('console.bgPhotoCurrent') : T('console.bgPhotoUse')}</span>
                        <button type="button" className={'dsh-wt_dragHandle' + (dragRowId === p.id ? ' dsh-wt_dragHandleOn' : '')} title={T('console.bgMediaDrag')} aria-label={T('console.bgMediaDrag')} onPointerDown={(e) => onHandleDown(p.id, e)}><svg width="10" height="12" viewBox="0 0 10 12" aria-hidden><circle cx="2.5" cy="2" r="1.1" fill="currentColor" /><circle cx="7.5" cy="2" r="1.1" fill="currentColor" /><circle cx="2.5" cy="6" r="1.1" fill="currentColor" /><circle cx="7.5" cy="6" r="1.1" fill="currentColor" /><circle cx="2.5" cy="10" r="1.1" fill="currentColor" /><circle cx="7.5" cy="10" r="1.1" fill="currentColor" /></svg></button>
                        <button type="button" className="dsh-wt_dropTrash" title={T('console.bgPhotoDelete')} aria-label={T('console.bgPhotoDelete')} onClick={(e) => { e.stopPropagation(); removePhotoById(p) }}><svg width="11" height="11" viewBox="0 0 16 16" aria-hidden><path d="M2.5 4.2h11M6.5 4.2V2.9c0-.6.4-1 .9-1h1.2c.5 0 .9.4.9 1v1.3M4.2 4.2l.5 8.1c0 .7.5 1.2 1.2 1.2h4.2c.7 0 1.2-.5 1.2-1.2l.5-8.1" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg></button>
                      </div>
                    ))
                  ) : (
                    <div className="dsh-wt_photoEmpty">{T('console.bgPhotoNone')}</div>
                  )}
                  <div className="dsh-wt_hslDivider" />
                </>
              )}
              {(() => {
                const v = bgEdit === 'plain' ? plainHsl : bgEdit === 'glow' ? glowHsl : photoHsl
                const sMax = bgEdit === 'plain' ? 100 : 200
                const lMax = bgEdit === 'plain' ? 100 : 200
                return (<>
                  {bgEdit === 'glow' && (
                    <div className="dsh-wt_hslRow" data-tip={T('console.bgTipSpeed')}><span className="dsh-wt_hslLabel">S</span><input className="dsh-wt_hslSlider" type="range" min={0} max={100} step={5} value={glowSpeed} onChange={(e) => onGlowSpeed(Number(e.target.value))} /><HslValInput value={glowSpeed} min={0} max={100} onCommit={onGlowSpeed} /></div>
                  )}
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipB')}><span className="dsh-wt_hslLabel">B</span><input className="dsh-wt_hslSlider" type="range" min={0} max={20} step={1} value={bgEdit === 'plain' ? plainBlur : bgEdit === 'glow' ? glowBlur : cardBlur} onChange={(e) => onModeBlur(bgEdit, Number(e.target.value))} /><HslValInput value={bgEdit === 'plain' ? plainBlur : bgEdit === 'glow' ? glowBlur : cardBlur} min={0} max={20} onCommit={(n) => onModeBlur(bgEdit, n)} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipT')}><span className="dsh-wt_hslLabel">T</span><input className="dsh-wt_hslSlider" type="range" min={0} max={30} step={1} value={bgEdit === 'plain' ? plainGrid : bgEdit === 'glow' ? glowGrid : gridOpacity} onChange={(e) => bgEdit === 'photo' ? onGridOpacity(Number(e.target.value)) : onModeGrid(bgEdit, Number(e.target.value))} /><HslValInput value={bgEdit === 'plain' ? plainGrid : bgEdit === 'glow' ? glowGrid : gridOpacity} min={0} max={30} onCommit={(n) => bgEdit === 'photo' ? onGridOpacity(n) : onModeGrid(bgEdit, n)} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipH')}><span className="dsh-wt_hslLabel">H</span><input className="dsh-wt_hslSlider" type="range" min={-180} max={180} step={1} value={v.h} onChange={(e) => editHsl(bgEdit, { h: Number(e.target.value) })} /><HslValInput value={v.h} min={-180} max={180} onCommit={(n) => editHsl(bgEdit, { h: n })} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipS')}><span className="dsh-wt_hslLabel">S</span><input className="dsh-wt_hslSlider" type="range" min={0} max={sMax} step={1} value={v.s} onChange={(e) => editHsl(bgEdit, { s: Number(e.target.value) })} /><HslValInput value={v.s} max={sMax} onCommit={(n) => editHsl(bgEdit, { s: n })} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipL')}><span className="dsh-wt_hslLabel">L</span><input className="dsh-wt_hslSlider" type="range" min={0} max={lMax} step={1} value={v.l} onChange={(e) => editHsl(bgEdit, { l: Number(e.target.value) })} /><HslValInput value={v.l} max={lMax} onCommit={(n) => editHsl(bgEdit, { l: n })} /></div>
                  <button type="button" className="dsh-wt_hslReset" onClick={() => resetHsl(bgEdit)}>{T('console.bgEditReset')}</button>
                </>)
              })()}
            </div>
          )
        )}
        {openMenu === 'cols' && (
          <div className="dsh-wt_drop">
            <div className="dsh-wt_hbar">
              <span className="dsh-wt_hbarFill" style={{ width: (8 + (cols - 1) * 21) + '%' }} />
              {[1, 2, 3, 4, 5].map((v) => (
                <button key={v} type="button" className="dsh-wt_hbarLine" style={{ left: (8 + (v - 1) * 21) + '%' }} aria-label={String(v)} title={String(v)} onClick={() => onCols(v)}></button>
              ))}
              <span className="dsh-wt_hbarKnob" style={{ left: (8 + (cols - 1) * 21) + '%' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 文件夹图标（重绘 SVG，与 better-sidebar 同款风格） */
function FolderIcon() {
  return (
    <svg className="dsh-wt_treeIcon" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M1.75 3.25A1.75 1.75 0 0 1 3.5 1.5h2.63a1.75 1.75 0 0 1 1.34.66l.62.79a1.75 1.75 0 0 0 1.34.66H12.5a1.75 1.75 0 0 1 1.75 1.75v7.39A1.75 1.75 0 0 1 12.5 14.5h-9a1.75 1.75 0 0 1-1.75-1.75V3.25Z" fill="var(--dsw-alias-state-accent-primary,#4f8ef7)" opacity="0.9" />
      <path d="M1.75 5.75h12.5v7a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75v-7Z" fill="var(--dsw-alias-state-accent-primary,#4f8ef7)" opacity="0.4" />
    </svg>
  )
}

/** 文件图标（重绘 SVG） */
function FileIcon() {
  return (
    <svg className="dsh-wt_treeIcon" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M4 1.5h5.25a1 1 0 0 1 .71.29l3.25 3.25a1 1 0 0 1 .29.71V13.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" fill="var(--dsw-alias-fill-l1,rgba(255,255,255,.06))" stroke="var(--dsw-alias-label-secondary,#9aa4b2)" strokeWidth="1.1" />
      <path d="M9.25 1.5V4.75h3.25" fill="none" stroke="var(--dsw-alias-label-secondary,#9aa4b2)" strokeWidth="1.1" />
    </svg>
  )
}

/** 资源管理器窗：树形展开（懒加载子目录；刷新/上一级均可用；.html 点击开浏览器标签） */
function ExplorerPane(props: { row: PaneRow; index: number }) {
  const cacheRef = useRef<Record<string, any[]>>({})
  const expandedRef = useRef<Set<string>>(new Set())
  const [rootPath, setRootPath] = useState('')
  const [error, setError] = useState('')
  const [, setTick] = useState(0)
  const rerender = () => setTick((t) => t + 1)

  const fetchDir = useCallback(async (path: string, force = false) => {
    if (!force && cacheRef.current[path]) return { path, entries: cacheRef.current[path] }
    try {
      const d = await postJson('/api/worktable/fs', {
        path,
        sessionId: splitEnv?.getScope()?.sessionId ?? '',
        cwd: splitEnv?.getScope()?.cwd ?? '',
      })
      const entries: any[] = d.entries ?? []
      cacheRef.current[d.path] = entries
      setError(d.error ? String(d.error) : '')
      return { path: d.path, entries }
    } catch (e) {
      setError(String(e))
      return { path, entries: [] }
    } finally {
      rerender()
    }
  }, [])

  const initRoot = useCallback(async () => {
    const r = await fetchDir(splitEnv?.getScope()?.cwd ?? '')
    setRootPath(r.path)
    rerender()
  }, [fetchDir])

  useEffect(() => { initRoot() }, [initRoot])

  const toggle = (path: string) => {
    if (expandedRef.current.has(path)) expandedRef.current.delete(path)
    else { expandedRef.current.add(path); fetchDir(path) }
    rerender()
  }

  const refresh = () => {
    cacheRef.current = {}
    expandedRef.current.clear()
    setError('')
    initRoot()
  }

  const goUp = () => {
    if (!rootPath) return
    const parent = parentPathOf(rootPath)
    if (parent === rootPath) return
    cacheRef.current = {}
    expandedRef.current.clear()
    setError('')
    fetchDir(parent).then((r) => { setRootPath(r.path); rerender() })
  }

  const renderLevel = (path: string, depth: number): any[] => {
    const entries = cacheRef.current[path]
    if (!entries) return []
    const nodes: any[] = []
    for (const e of entries) {
      const isOpen = expandedRef.current.has(e.path)
      nodes.push(
        <div key={e.path}>
          <button
            type="button"
            className="dsh-wt_treeRow"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              if (e.isDir) { toggle(e.path); return }
              if (/\.html?$/i.test(e.name)) {
                // 目录级静态托管：相对引用（./assets/...）在所在目录下解析，页面可完整渲染
                const dir = parentPathOf(e.path)
                splitStore.openTab(props.row, props.index, {
                  kind: 'iframe',
                  url: '/api/worktable/site/' + encodeURIComponent(dir) + '/' + encodeURIComponent(e.name),
                  title: e.name,
                })
              } else if (/\.(md|markdown|mdown|txt|log|tsx|ts|jsx|js|css|json|pdf|png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(e.name)) {
                splitStore.openTab(props.row, props.index, { kind: 'file', path: e.path })
              } else {
                setError(T('pane.openLater'))
              }
            }}
          >
            <span className={'dsh-wt_treeArrow' + (e.isDir && isOpen ? ' dsh-wt_treeArrowOpen' : '')} aria-hidden>{e.isDir ? '▸' : ''}</span>
            {e.isDir ? <FolderIcon /> : <FileIcon />}
            <span className="dsh-wt_treeName">{e.name}</span>
          </button>
          {e.isDir && isOpen && renderLevel(e.path, depth + 1)}
        </div>,
      )
    }
    return nodes
  }

  return (
    <>
      <div className="dsh-wt_subBar">
        <button type="button" className="dsh-wt_subBtn" title="上一级" onClick={goUp}>⬆</button>
        <button type="button" className="dsh-wt_subBtn" title="刷新" onClick={refresh}>↻</button>
        <span className="dsh-wt_subPath">{rootPath || '…'}</span>
      </div>
      <div className="dsh-wt_subList">
        {error && <div className="dsh-wt_subEmpty">{error}</div>}
        {!error && cacheRef.current[rootPath]?.length === 0 && <div className="dsh-wt_subEmpty">—</div>}
        {renderLevel(rootPath, 0)}
      </div>
    </>
  )
}

/** 源代码管理窗（服务端 /api/worktable/git） */
function GitPane() {
  const [snap, setSnap] = useState<{ isRepo: boolean; branch?: string; entries: any[] } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    postJson('/api/worktable/git', {
      sessionId: splitEnv?.getScope()?.sessionId ?? '',
      cwd: splitEnv?.getScope()?.cwd ?? '',
    })
      .then(setSnap)
      .catch((e) => setError(String(e)))
  }, [])
  useEffect(() => { load() }, [load])
  return (
    <>
      <div className="dsh-wt_subBar">
        <button type="button" className="dsh-wt_subBtn" title="刷新" onClick={load}>↻</button>
        <span className="dsh-wt_subPath">{snap?.isRepo ? ('⎇ ' + snap.branch) : ''}</span>
      </div>
      <div className="dsh-wt_subList">
        {error && <div className="dsh-wt_subEmpty">{error}</div>}
        {!error && snap && !snap.isRepo && <div className="dsh-wt_subEmpty">{T('pane.gitNotRepo')}</div>}
        {!error && snap?.isRepo && snap.entries.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.gitClean')}</div>}
        {!error && snap?.isRepo && snap.entries.map((e, i) => (
          <div key={i} className="dsh-wt_subRow dsh-wt_subRowStatic">
            <span className={'dsh-wt_gitXY dsh-wt_gitXY' + (e.xy.includes('A') || e.xy.includes('M') ? 'Mod' : 'New')}>{e.xy.trim()}</span>
            <span className="dsh-wt_subName">{e.path}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/** 任务管理窗：后台任务 + 子代理（Agent 情况；2s 刷新） */
function JobsPane() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 2000)
    return () => window.clearInterval(timer)
  }, [])
  const jobs = splitEnv?.getJobs?.() ?? []
  const subagents = splitEnv?.getSubagents?.() ?? []
  return (
    <div className="dsh-wt_subList">
      <div className="dsh-wt_subSection">{T('pane.jobsTitle')}</div>
      {jobs.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.jobsEmpty')}</div>}
      {jobs.map((j) => (
        <div key={j.id} className="dsh-wt_subRow dsh-wt_subRowStatic">
          <span className={'dsh-wt_jobDot dsh-wt_jobDot-' + j.status} aria-hidden>●</span>
          <span className="dsh-wt_subName">{j.label}</span>
          <span className="dsh-wt_subTag">{j.kind}</span>
        </div>
      ))}
      <div className="dsh-wt_subSection">{T('pane.subagents')}</div>
      {subagents.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.subagentsEmpty')}</div>}
      {subagents.map((s: any, i: number) => (
        <div key={s?.id ?? i} className="dsh-wt_subRow dsh-wt_subRowStatic" style={{ paddingLeft: 8 + (s?.depth ?? 0) * 12 }}>
          <span className={'dsh-wt_jobDot dsh-wt_jobDot-' + (s?.status ?? 'stopping')} aria-hidden>●</span>
          <span className="dsh-wt_subName">{s?.label ?? s?.title ?? s?.name ?? '—'}</span>
          {s?.status && <span className="dsh-wt_subTag">{s.status}</span>}
        </div>
      ))}
    </div>
  )
}

/** 终端窗（WS /api/worktable/term + node-pty） */
function TerminalPane() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let term: any = null
    let ws: WebSocket | null = null
    let disposed = false
    let fit: FitAddon | null = null
    try {
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, Menlo, monospace',
        fontSize: 12,
        theme: { background: '#010409' },
      })
      // 尺寸贴合必须走 addon：xterm 实例上没有 fit 方法。
      // （曾经用 typeof 守卫守一个不存在的方法，守卫恒假 → 尺寸永远是连接时的 80×24）
      fit = new FitAddon()
      term.loadAddon(fit)
      // GPU 渲染器：大量输出时不再掉帧。加载失败（无 WebGL）静默回落默认渲染器；
      // 运行中丢上下文时释放该 addon 同样回落，避免终端整片变空白
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => { try { webgl.dispose() } catch {} })
        term.loadAddon(webgl)
      } catch {}
    } catch {
      setFailed(T('pane.termFail'))
      return
    }
    term.open(el)
    const refit = (): boolean => {
      if (!fit) return false
      try { fit.fit(); return true } catch { return false }
    }
    // fit 必须在 open 之后：open 之前没有可测的尺寸
    refit()
    // 强制自动换行（DECAWM on）：超长行在窗口宽度处换行，不被截断
    try { term.write('\x1b[?7h') } catch {}
    const focusTerm = () => { try { term.focus() } catch {} }
    focusTerm()
    el.addEventListener('pointerdown', focusTerm)
    const scope = splitEnv?.getScope?.()
    try {
      // 尺寸取 fit 后的真实 cols/rows：此前硬编码 80×24，终端永远不知道窗格有多宽
      const url = hostWebSocketUrl('/api/worktable/term?sessionId=' + encodeURIComponent(scope?.sessionId ?? '') + '&cwd=' + encodeURIComponent(scope?.cwd ?? '') + '&cols=' + term.cols + '&rows=' + term.rows)
      ws = new WebSocket(url)
    } catch {
      term.dispose()
      setFailed(T('pane.termFail'))
      return
    }
    const pushSize = () => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onopen = () => { focusTerm(); refit(); pushSize(); try { term.write('\x1b[?7h') } catch {} }
    ws.onmessage = (ev) => { try { term.write(String(ev.data)) } catch {} }
    ws.onclose = () => { if (!disposed) { try { term.write('\r\n[连接已关闭]') } catch {} } }
    ws.onerror = () => { if (!disposed) setFailed(T('pane.termFail')) }
    term.onData((d: string) => { if (ws && ws.readyState === 1) ws.send(d) })
    const ro = new ResizeObserver(() => { if (refit()) pushSize() })
    ro.observe(el)
    // ── 剪贴板：xterm 自己不碰系统剪贴板，复制/粘贴必须显式接线 ──
    const copySel = async (): Promise<boolean> => {
      const sel = term.getSelection()
      if (!sel) return false
      try { await navigator.clipboard.writeText(sel); return true } catch { return false }
    }
    const pasteClip = async () => {
      try { const t = await navigator.clipboard.readText(); if (t) term.paste(t) } catch {}
    }
    // Ctrl+C 仍发给 pty 做中断，复制走 Ctrl+Shift+C（Windows Terminal 的约定）
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || !e.shiftKey) return true
      const k = (e.key || '').toLowerCase()
      if (k === 'c') { void copySel(); return false }
      if (k === 'v') { void pasteClip(); return false }
      return true
    })
    // 终端里的右键归终端：有选中 → 复制，无选中 → 粘贴。
    // 就地掐断冒泡 —— 窗格那层 onContextMenu 挂在 React 根上，不掐断就会在终端里弹出窗格菜单
    // （标题栏 / 标签栏上的右键不受影响，仍可开窗格菜单）
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (term.hasSelection()) void copySel()
      else void pasteClip()
    }
    el.addEventListener('contextmenu', onCtx)
    return () => {
      disposed = true
      el.removeEventListener('contextmenu', onCtx)
      ro.disconnect()
      try { ws?.close() } catch {}
      try { term.dispose() } catch {}
    }
  }, [])
  if (failed) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{failed}</span></div>
  }
  return <div ref={hostRef} className="dsh-wt_termHost" />
}

const mdRenderer = new MarkdownIt({ linkify: true })

const IMAGE_EXTS = /[.](png|jpe?g|gif|webp|svg|bmp|ico)$/i
const MD_EXTS = /[.](md|markdown|mdown)$/i

/** 项目记忆面板（对齐 BotHarness soul.ts）：
 *  两个常驻文件 SOUL.md（我是谁）/ MEMORY.md（记忆索引）真正注入 system prompt，
 *  各带字符上限（超限只截断注入内容，磁盘文件不动），标题带用量百分比；
 *  其他 .md 是详情文件，不自动注入，供 MEMORY.md 索引 + 需要时阅读。 */
const MEM_LIMITS = { soul: 5000, coreMemory: 3000 }
const MEM_MIN = 500
const MEM_MAX = 50000
const MEM_LIMIT_KEY = 'dsh.worktable.memLimits.v1'

function memLimitsLoad(): { soul: number; coreMemory: number } {
  try {
    const raw = localStorage.getItem(MEM_LIMIT_KEY)
    if (!raw) return { ...MEM_LIMITS }
    const p = JSON.parse(raw)
    const ok = (v: any) => typeof v === 'number' && Number.isInteger(v) && v >= MEM_MIN && v <= MEM_MAX
    return { soul: ok(p?.soul) ? p.soul : MEM_LIMITS.soul, coreMemory: ok(p?.coreMemory) ? p.coreMemory : MEM_LIMITS.coreMemory }
  } catch { return { ...MEM_LIMITS } }
}

function MemoryPanel(props: { folder: string; projectName: string; onClose: () => void }) {
  const folder = props.folder
  // 显式空态：没绑文件夹时 SOUL/MEMORY 路径必然落空——静默空白最难排查（DSH-P：没数据不许一片白）
  if (!folder) {
    return (
      <div className="dsh-wt_memPanel">
        <div className="dsh-wt_memHead">
          <span className="dsh-wt_memTitle">🧠 {T('mem.title')}</span>
          <span className="dsh-wt_memProj">{props.projectName}</span>
          <button type="button" className="dsh-wt_memClose" onClick={props.onClose} aria-label="close">✕</button>
        </div>
        <div className="dsh-wt_memBody">
          <div className="dsh-wt_paneWip">
            <span className="dsh-wt_paneWipIcon" aria-hidden>📂</span>
            <span className="dsh-wt_paneWipText">{T('mem.noFolder')}</span>
          </div>
        </div>
      </div>
    )
  }
  const memRoot = joinPath(joinPath(folder, '.dsh-worktable'), 'memory')
  const soulPath = joinPath(memRoot, 'SOUL.md')
  const corePath = joinPath(memRoot, 'MEMORY.md')
  const agentsPath = joinPath(folder, 'AGENTS.md')
  const [sel, setSel] = useState<string>(soulPath)
  const [text, setText] = useState('')
  const [orig, setOrig] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)
  const [files, setFiles] = useState<{ name: string; path: string }[]>([])
  const [newName, setNewName] = useState('')
  const [limits, setLimits] = useState<{ soul: number; coreMemory: number }>(memLimitsLoad)
  const [limitOpen, setLimitOpen] = useState(false)
  const [limitDraft, setLimitDraft] = useState<{ soul: string; coreMemory: string }>({ soul: '', coreMemory: '' })
  /** Git 历史面板：提交列表（最新在前）+ 恢复确认 */
  const [histOpen, setHistOpen] = useState(false)
  const [commits, setCommits] = useState<{ short: string; sha: string; message: string; date: string }[]>([])
  const [histLoading, setHistLoading] = useState(false)
  const [lastCommit, setLastCommit] = useState('')

  const load = useCallback(async (path: string) => {
    setLoading(true); setErr(''); setSaved(false)
    try {
      const r = await fetch('/api/worktable/file?path=' + encodeURIComponent(path), { cache: 'no-store' })
      if (r.ok) { const t = await r.text(); setText(t); setOrig(t) }
      else if (r.status === 404) {
        // 不存在 = 空文件，可直接写；但把实际读取路径显示出来——
        // 「面板说空但磁盘有文件」多半是路径解析错位，一行提示直接定位（防呆）
        setText(''); setOrig('')
        setErr(T('mem.notFound', { path }))
      }
      else throw new Error('HTTP ' + r.status)
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setLoading(false) }
  }, [])

  /** 列出记忆目录 + 项目根的 .md（排除 SOUL/MEMORY/AGENTS——它们各自有固定位置） */
  const listFiles = useCallback(async () => {
    const collect = async (dir: string) => {
      try {
        const d = await postJson('/api/worktable/fs', { path: dir })
        return (d?.entries ?? []).filter((e: any) => e && !e.isDir && /\.(md|markdown)$/i.test(e.name))
          .map((e: any) => ({ name: e.name, path: e.path }))
      } catch { return [] as { name: string; path: string }[] }
    }
    const [mem, root] = await Promise.all([collect(memRoot), collect(folder)])
    const skip = new Set(['SOUL.md', 'MEMORY.md', 'AGENTS.md'])
    setFiles([...mem, ...root.filter((f) => !skip.has(f.name))])
  }, [memRoot, folder])

  useEffect(() => { void load(sel); void listFiles() }, [sel, load, listFiles])

  const save = async () => {
    setLoading(true); setErr(''); setSaved(false)
    try {
      const isStanding = sel === soulPath || sel === corePath || sel === agentsPath
      if (isStanding) {
        // 常驻文件走 memory/save：原子写 + git 自动提交
        const file = sel === agentsPath ? 'AGENTS.md' : basenameOf(sel)
        const root = sel === agentsPath ? folder : memRoot
        const r = await fetch('/api/worktable/memory/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root, file, content: text, summary: 'Update ' + file }) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || !d?.ok) throw new Error(d?.error ?? 'HTTP ' + r.status)
        setLastCommit(typeof d.commit === 'string' ? d.commit : '')
      } else {
        const r = await fetch('/api/worktable/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: sel, content: text }) })
        if (!r.ok) throw new Error('HTTP ' + r.status)
      }
      setOrig(text); setSaved(true); void listFiles()
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setLoading(false) }
  }

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    if (!/\.(md|markdown)$/i.test(name) || /[\\/]/.test(name)) { setErr(T('mem.newPh')); return }
    const path = joinPath(memRoot, name)
    setLoading(true); setErr('')
    try {
      const r = await fetch('/api/worktable/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content: '# ' + name.replace(/\.md$/i, '') + '\n\n' }) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      setNewName(''); await listFiles(); setSel(path)
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setLoading(false) }
  }

  const del = async (path: string) => {
    try {
      const r = await fetch('/api/worktable/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      if (sel === path) setSel(soulPath)
      void listFiles()
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  /** 当前文件是否常驻（决定显示用量/上限） */
  const roleOf = (path: string): { role: 'soul' | 'coreMemory' | 'agents' | 'detail'; label: string; limit: number; hint: string } | null => {
    if (path === soulPath) return { role: 'soul', label: T('mem.soul'), limit: limits.soul, hint: T('mem.soulHint') }
    if (path === corePath) return { role: 'coreMemory', label: T('mem.core'), limit: limits.coreMemory, hint: T('mem.coreHint') }
    if (path === agentsPath) return { role: 'agents', label: T('mem.agents'), limit: 0, hint: T('mem.agentsHint') }
    return { role: 'detail', label: T('mem.detail'), limit: 0, hint: T('mem.detailHint') }
  }
  const meta = roleOf(sel)

  const dirty = text !== orig
  const chars = [...text.trimEnd()].length
  const over = !!meta && meta.limit > 0 && chars > meta.limit
  const pct = meta && meta.limit > 0 ? Math.round((chars / meta.limit) * 100) : 0

  const openLimitEditor = () => {
    setLimitDraft({ soul: String(limits.soul), coreMemory: String(limits.coreMemory) })
    setLimitOpen(true)
  }
  const openHistory = async () => {
    setHistOpen(true); setHistLoading(true)
    try {
      const r = await fetch('/api/worktable/memory/history?root=' + encodeURIComponent(memRoot), { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      setCommits(Array.isArray(d?.commits) ? d.commits : [])
    } catch { setCommits([]) } finally { setHistLoading(false) }
  }
  const doRestore = async (sha: string) => {
    if (!confirm(T('mem.restoreConfirm', { sha: sha.slice(0, 7) }))) return
    try {
      const r = await fetch('/api/worktable/memory/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: memRoot, sha }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d?.ok) throw new Error(d?.error ?? 'HTTP ' + r.status)
      await void load(sel); await openHistory()
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  const saveLimits = () => {
    const s = parseInt(limitDraft.soul, 10)
    const c = parseInt(limitDraft.coreMemory, 10)
    const clamp = (v: number, fb: number) => (Number.isInteger(v) && v >= MEM_MIN && v <= MEM_MAX ? v : fb)
    const next = { soul: clamp(s, MEM_LIMITS.soul), coreMemory: clamp(c, MEM_LIMITS.coreMemory) }
    setLimits(next)
    try { localStorage.setItem(MEM_LIMIT_KEY, JSON.stringify(next)) } catch {}
    setLimitOpen(false)
  }

  return (
    <div className="dsh-wt_memPanel">
      <div className="dsh-wt_memHead">
        <span className="dsh-wt_memTitle">🧠 {T('mem.title')}</span>
        <span className="dsh-wt_memProj" title={memRoot}>{props.projectName}</span>
        <button type="button" className="dsh-wt_memClose" onClick={props.onClose} aria-label="close">✕</button>
      </div>
      <div className="dsh-wt_memBody">
        <div className="dsh-wt_memSide">
          <div className="dsh-wt_memSideLabel">{T('mem.standing')}</div>
          <button type="button" className={'dsh-wt_memFile' + (sel === soulPath ? ' dsh-wt_memFileOn' : '')} onClick={() => setSel(soulPath)}>
            <span aria-hidden>✦</span>{T('mem.soul')}
          </button>
          <button type="button" className={'dsh-wt_memFile' + (sel === corePath ? ' dsh-wt_memFileOn' : '')} onClick={() => setSel(corePath)}>
            <span aria-hidden>✦</span>{T('mem.core')}
          </button>
          <button type="button" className={'dsh-wt_memFile' + (sel === agentsPath ? ' dsh-wt_memFileOn' : '')} onClick={() => setSel(agentsPath)}>
            <span aria-hidden>📌</span>{T('mem.agents')}
          </button>
          <div className="dsh-wt_memSideLabel">{T('mem.files')}</div>
          {files.length === 0 && <div className="dsh-wt_memEmpty">{T('mem.none')}</div>}
          {files.map((f) => (
            <div key={f.path} className={'dsh-wt_memRow' + (sel === f.path ? ' dsh-wt_memFileOn' : '')}>
              <button type="button" className="dsh-wt_memFileName" onClick={() => setSel(f.path)} title={f.path}>{f.name}</button>
              <button type="button" className="dsh-wt_memDel" title={T('mem.del')} onClick={() => void del(f.path)}>✕</button>
            </div>
          ))}
          <div className="dsh-wt_memNewRow">
            <input className="dsh-wt_memNewInput" placeholder={T('mem.newPh')} value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void create() }} />
            <button type="button" className="dsh-wt_memBtn" onClick={() => void create()}>{T('mem.new')}</button>
          </div>
          <button type="button" className="dsh-wt_memBtn dsh-wt_memLimitBtn" onClick={openLimitEditor}>⚙ {T('mem.limits')}</button>
          <button type="button" className="dsh-wt_memBtn dsh-wt_memLimitBtn" onClick={() => void openHistory()}>⏱ {T('mem.history')}</button>
        </div>
        <div className="dsh-wt_memMain">
          {meta && <p className="dsh-wt_memHint">{meta.hint}</p>}
          {err && <p className="dsh-wt_addError">{err}</p>}
          {over && <p className="dsh-wt_memOver">{T('mem.overLimit', { chars: chars.toLocaleString('en-US'), limit: meta!.limit.toLocaleString('en-US') })}</p>}
          <textarea
            className="dsh-wt_memEditor"
            value={text}
            spellCheck={false}
            placeholder={T('mem.empty')}
            onChange={(e) => { setText(e.target.value); setSaved(false) }}
          />
          <div className="dsh-wt_memFoot">
            {meta && meta.limit > 0 ? (
              <span className={'dsh-wt_memCount' + (over ? ' dsh-wt_memCountOver' : '')}>
                [{pct}% — {chars.toLocaleString('en-US')}/{meta.limit.toLocaleString('en-US')} {T('mem.chars')}]
              </span>
            ) : (
              <span className="dsh-wt_memCount">{chars.toLocaleString('en-US')} {T('mem.chars')}</span>
            )}
            <button type="button" className="dsh-wt_memBtn" onClick={() => void load(sel)} disabled={loading}>{T('mem.reload')}</button>
            <button type="button" className="dsh-wt_memBtn dsh-wt_memSave" onClick={() => void save()} disabled={loading || !dirty}>
              {saved && !dirty ? '✓ ' + T('mem.saved') + (lastCommit ? ' · ' + lastCommit : '') : T('mem.save')}
            </button>
          </div>
        </div>
      </div>
      {histOpen && (
        <div className="dsh-wt_memLimitPop">
          <div className="dsh-wt_memHistHead">
            <span>⏱ {T('mem.history')}</span>
            <button type="button" className="dsh-wt_memClose" onClick={() => setHistOpen(false)} aria-label="close">✕</button>
          </div>
          {histLoading && <p className="dsh-wt_memHint">…</p>}
          {!histLoading && commits.length === 0 && <p className="dsh-wt_memHint">{T('mem.histEmpty')}</p>}
          <div className="dsh-wt_memHistList">
            {commits.map((c) => (
              <div key={c.sha} className="dsh-wt_memHistRow">
                <span className="dsh-wt_memHistSha">{c.short}</span>
                <span className="dsh-wt_memHistMsg" title={c.message}>{c.message}</span>
                <span className="dsh-wt_memHistDate">{c.date}</span>
                <button type="button" className="dsh-wt_memBtn" onClick={() => void doRestore(c.sha)}>{T('mem.restore')}</button>
              </div>
            ))}
          </div>
          <p className="dsh-wt_memHint">{T('mem.histHint')}</p>
        </div>
      )}
      {limitOpen && (
        <div className="dsh-wt_memLimitPop">
          <div className="dsh-wt_memLimitRow">
            <span>{T('mem.soul')}</span>
            <input value={limitDraft.soul} onChange={(e) => setLimitDraft((d) => ({ ...d, soul: e.target.value }))} />
          </div>
          <div className="dsh-wt_memLimitRow">
            <span>{T('mem.core')}</span>
            <input value={limitDraft.coreMemory} onChange={(e) => setLimitDraft((d) => ({ ...d, coreMemory: e.target.value }))} />
          </div>
          <p className="dsh-wt_memHint">{T('mem.limitsHint', { min: String(MEM_MIN), max: String(MEM_MAX) })}</p>
          <div className="dsh-wt_memLimitActs">
            <button type="button" className="dsh-wt_memBtn" onClick={() => setLimitOpen(false)}>{T('mem.cancel')}</button>
            <button type="button" className="dsh-wt_memBtn dsh-wt_memSave" onClick={saveLimits}>{T('mem.save')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function FileViewer(props: { path: string }) {
  const ext = (props.path.split('.').pop() || '').toLowerCase()
  const fileUrl = '/api/worktable/file?path=' + encodeURIComponent(props.path)
  if (ext === 'pdf') {
    return <iframe className="dsh-wt_paneFrame" src={fileUrl} title={basenameOf(props.path)} />
  }
  if (IMAGE_EXTS.test('.' + ext)) {
    return (
      <div className="dsh-wt_imgView">
        <img src={fileUrl} alt={basenameOf(props.path)} />
      </div>
    )
  }
  return <TextViewer path={props.path} fileUrl={fileUrl} isMd={MD_EXTS.test('.' + ext)} />
}

/** 代码文件语言映射（预览语法着色） */
const CODE_LANGS: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', css: 'css', json: 'json' }
const CODE_EXTS = /[.](tsx|ts|jsx|js|css|json)$/i

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function codeHtml(text: string, ext: string): string {
  const lang = CODE_LANGS[ext] ?? ''
  if (lang) {
    try { return hljs.highlight(text, { language: lang }).value } catch { return escapeHtml(text) }
  }
  return escapeHtml(text)
}

/** 文本预览（fetch 原文 → MD 渲染 / 代码高亮 / <pre> 等宽展示）；全部文本类型支持编辑/预览切换并可保存回磁盘 */
function TextViewer(props: { path: string; fileUrl: string; isMd: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveFail, setSaveFail] = useState(false)
  useEffect(() => {
    let dead = false
    setText(null)
    setError('')
    fetch(props.fileUrl)
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.text()
      })
      .then((t) => { if (!dead) setText(t) })
      .catch((e) => { if (!dead) setError(String(e)) })
    return () => { dead = true }
  }, [props.fileUrl])
  const enterEdit = () => { setDraft(text ?? ''); setSaveFail(false); setMode('edit') }
  const save = async () => {
    setSaving(true)
    setSaveFail(false)
    try {
      const r = await fetch('/api/worktable/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: props.path, content: draft }),
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      setText(draft)
      setMode('preview')
    } catch {
      setSaveFail(true)
    } finally {
      setSaving(false)
    }
  }
  if (error) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('file.fail')}：{error}</span></div>
  }
  if (text == null) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('file.loading')}</span></div>
  }
  const ext = (props.path.split('.').pop() || '').toLowerCase()
  const isCode = CODE_EXTS.test('.' + ext)
  return (
    <>
      <div className="dsh-wt_mdBar">
        <button type="button" className={'dsh-wt_mdBtn' + (mode === 'preview' ? ' dsh-wt_mdBtnOn' : '')} onClick={() => setMode('preview')}>{T('file.preview')}</button>
        <button type="button" className={'dsh-wt_mdBtn' + (mode === 'edit' ? ' dsh-wt_mdBtnOn' : '')} onClick={enterEdit}>{T('file.edit')}</button>
        {mode === 'edit' && (
          <button type="button" className="dsh-wt_mdSave" disabled={saving} onClick={save}>{saving ? '…' : T('file.save')}</button>
        )}
        {saveFail && <span className="dsh-wt_mdMsg">{T('file.saveFail')}</span>}
      </div>
      {mode === 'edit'
        ? <textarea className="dsh-wt_mdEdit" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
        : props.isMd
          ? (
            <div className="dsh-wt_fileView">
              <div
                className="dsh-wt_md"
                dangerouslySetInnerHTML={{ __html: mdRenderer.render(text) }}
                onClick={(e: any) => {
                  const a = e.target && e.target.closest ? (e.target.closest('a') as HTMLAnchorElement | null) : null
                  if (!a) return
                  e.preventDefault()
                  const href = a.getAttribute('href') || ''
                  if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener')
                }}
              />
            </div>
          )
          : isCode
            ? (
              <div className="dsh-wt_fileView">
                <pre className="dsh-wt_code"><code dangerouslySetInnerHTML={{ __html: codeHtml(text, ext) }} /></pre>
              </div>
            )
            : <div className="dsh-wt_fileView"><pre className="dsh-wt_txt">{text}</pre></div>}
    </>
  )
}

/** 自制下拉列表（原生 select 无法美化）：文件夹分组标题 + 1px 细分隔线 + 选项列表 */
function SelectPop(props: {
  value: string | null
  groups: { title: string; items: { id: string; label: string; isCurrent?: boolean }[] }[]
  placeholder?: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const flat = props.groups.flatMap((g) => g.items)
  const selected = flat.find((i) => i.id === props.value)
  return (
    <div className="dsh-wt_select">
      <button type="button" className="dsh-wt_selectBtn" onClick={() => setOpen((v) => !v)}>
        <span className={'dsh-wt_selectVal' + (selected ? '' : ' dsh-wt_selectPh')}>{selected?.label ?? props.placeholder ?? ''}</span>
        <span className="dsh-wt_selectCaret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="dsh-wt_selectList">
          {props.groups.map((g, gi) => (
            <Fragment key={g.title || 'g' + gi}>
              {g.title && (
                <>
                  <div className="dsh-wt_selectDivider" />
                  <div className="dsh-wt_selectGroup">📁 {g.title}</div>
                </>
              )}
              {g.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={'dsh-wt_selectItem' + (it.id === props.value ? ' dsh-wt_selectItemOn' : '')}
                  onClick={() => { props.onChange(it.id); setOpen(false) }}
                >
                  <span className="dsh-wt_selectItemTitle">{it.label}</span>
                  {it.isCurrent && <span className="dsh-wt_selectCurrent">{T('custom.sessionCurrent')}</span>}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

/** 自定义窗口：居中对话框。两种模式：新建专属会话 / 发送到已有会话（默认当前会话）。 */
function CustomPane(props: { paneTitle?: string; row?: PaneRow; index?: number }) {
  const paneTitle = props.row === undefined ? (props.paneTitle ?? '') :
    (windowLabelOf(props.row, props.index ?? 0).match(/^窗口\d+/)?.[0] ?? '')
  try { (window as any).__dshLastCustomPaneTitle = paneTitle } catch {}
  const custom = splitEnv?.custom
  const [requirement, setRequirement] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>(() => custom?.getProjects?.() ?? [])
  const [mode, setMode] = useState<'new' | 'existing'>('existing')
  const [sessionGroups, setSessionGroups] = useState<{ title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  // 分组（宿主工作区）三态：未分组 / 现有组 / 新建组
  const [wsGroups, setWsGroups] = useState<{ id: string; title: string; path: string }[]>([])
  const [groupMode, setGroupMode] = useState<'none' | 'existing' | 'new'>('none')
  const [groupId, setGroupId] = useState<string | null>(null)
  const groupTouchedRef = useRef(false)
  const [newGroupParent, setNewGroupParent] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [fail, setFail] = useState('')
  const [bindNote, setBindNote] = useState<'auto' | 'kept' | 'none'>('none')
  // 默认项目 = 当前工作区所属项目；默认会话 = 当前会话；默认分组 = 当前会话所在工作区
  useEffect(() => {
    const list = custom?.getProjects?.() ?? []
    setProjects(list)
    const cur = custom?.currentProjectId?.() ?? null
    setProjectId(cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null))
    setWsGroups((custom?.getWorkspaces?.() ?? []).map((w) => ({ id: w.id, title: w.title, path: w.path })))
    custom?.getSessions?.().then((res) => {
      setSessionGroups(res.groups)
      const flat = res.groups.flatMap((g) => g.sessions)
      setSessionId(flat.find((s) => s.isCurrent)?.id ?? flat[0]?.id ?? null)
      const curId = flat.find((s) => s.isCurrent)?.id
      const home = curId ? (custom?.getWorkspaces?.() ?? []).find((w) => (w.sessionIds ?? []).includes(curId)) : null
      // A delayed default lookup must not overwrite the user's explicit choice.
      if (home && !groupTouchedRef.current) { setGroupMode('existing'); setGroupId(home.id) }
    }).catch(() => { setSessionGroups([]) })
  }, [custom])
  const submit = async () => {
    const text = requirement.trim()
    if (!text || !projectId || !custom) return
    setBusy(true)
    setFail('')
    try {
      const proj = projects.find((p) => p.id === projectId)
      const pname = proj?.name ?? projectId
      if (mode === 'new') {
        let group: any = { kind: 'none' }
        if (groupMode === 'existing' && groupId) group = { kind: 'existing', workspaceId: groupId }
        else if (groupMode === 'new') {
          if (!newGroupParent.trim() || !newGroupName.trim()) { setFail(T('custom.groupNeedPath')); return }
          group = { kind: 'new', parent: newGroupParent.trim(), name: newGroupName.trim() }
        }
        const sid = await custom.submit(projectId, pname, text, group, paneTitle)
        setBindNote((custom.autoBind?.(sid) ?? 'none') as any)
      } else {
        if (!sessionId) return
        await custom.sendToSession(sessionId, projectId, pname, text, paneTitle)
        setBindNote((custom.autoBind?.(sessionId) ?? 'none') as any)
      }
      setDone(true)
    } catch (e) {
      setFail(String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!custom) {
    // 显式空态（借鉴 DSH-P「面板类型总览」：没数据时不许一片白）：
    // 说清「为什么没有」+「下一步做什么」，而不是只写「开发中」。
    return (
      <div className="dsh-wt_paneWip">
        <span className="dsh-wt_paneWipIcon" aria-hidden>{BUILTIN_ICONS.custom}</span>
        <span className="dsh-wt_paneWipText">{T('custom.unavailable')}</span>
      </div>
    )
  }
  if (done) {
    return (
      <div className="dsh-wt_customBox">
        <span className="dsh-wt_customDone" aria-hidden>✅</span>
        <p className="dsh-wt_customDoneText">{mode === 'new' ? T('custom.done') : T('custom.sent')}</p>
        <p className="dsh-wt_customDoneHint">{T('custom.doneHint')}</p>
        {bindNote !== 'none' && (
          <p className="dsh-wt_customDoneBind">{bindNote === 'auto' ? T('custom.autoBound') : T('custom.keptBinding')}</p>
        )}
      </div>
    )
  }
  return (
    <div className="dsh-wt_customBox">
      <div className="dsh-wt_customCard">
        <span className="dsh-wt_customTitle">✨ {T('custom.title')}</span>
        <div className="dsh-wt_customModes">
          <button type="button" className={'dsh-wt_customModeBtn' + (mode === 'existing' ? ' dsh-wt_customModeBtnOn' : '')} onClick={() => setMode('existing')}>{T('custom.modeSend')}</button>
          <button type="button" className={'dsh-wt_customModeBtn' + (mode === 'new' ? ' dsh-wt_customModeBtnOn' : '')} onClick={() => setMode('new')}>{T('custom.modeNew')}</button>
        </div>
        <p className="dsh-wt_customHint">{mode === 'new' ? T('custom.hint') : T('custom.hintSend')}</p>
        <textarea
          className="dsh-wt_customInput"
          autoFocus
          placeholder={T('custom.placeholder')}
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
        />
        {mode === 'existing' && (
          <div className="dsh-wt_customRow">
            <span className="dsh-wt_customLabel">{T('custom.session')}</span>
            <SelectPop
              value={sessionId}
              groups={sessionGroups.map((g) => ({
                title: g.title,
                items: g.sessions.map((s) => ({ id: s.id, label: s.title, isCurrent: s.isCurrent })),
              }))}
              placeholder={T('custom.session')}
              onChange={setSessionId}
            />
          </div>
        )}
        <div className="dsh-wt_customRow">
          <span className="dsh-wt_customLabel">{T('custom.project')}</span>
          <SelectPop
            value={projectId}
            groups={[{ title: '', items: projects.map((p) => ({ id: p.id, label: p.name })) }]}
            placeholder={T('custom.project')}
            onChange={setProjectId}
          />
        </div>
        {mode === 'new' && (
          <div className="dsh-wt_customRow">
            <span className="dsh-wt_customLabel">{T('custom.group')}</span>
            <SelectPop
              value={groupMode === 'none' ? '__none' : groupMode === 'new' ? '__new' : groupId}
              groups={[{
                title: '',
                items: [
                  { id: '__none', label: T('custom.groupNone') },
                  ...wsGroups.map((w) => ({ id: w.id, label: w.title })),
                  { id: '__new', label: T('custom.groupNew') },
                ],
              }]}
              placeholder={T('custom.group')}
              onChange={(id) => {
                groupTouchedRef.current = true
                if (id === '__none') setGroupMode('none')
                else if (id === '__new') setGroupMode('new')
                else { setGroupMode('existing'); setGroupId(id) }
              }}
            />
          </div>
        )}
        {mode === 'new' && groupMode === 'new' && (
          <>
            <div className="dsh-wt_customRow">
              <span className="dsh-wt_customLabel">{T('custom.groupNewParent')}</span>
              <input
                className="dsh-wt_customPathInput"
                placeholder={T('custom.groupNewParentPh')}
                value={newGroupParent}
                onChange={(e) => setNewGroupParent(e.target.value)}
              />
            </div>
            <div className="dsh-wt_customRow">
              <span className="dsh-wt_customLabel">{T('custom.groupNewName')}</span>
              <input
                className="dsh-wt_customPathInput"
                placeholder={T('custom.groupNewNamePh')}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
            </div>
          </>
        )}
        <button
          type="button"
          className="dsh-wt_customSend"
          disabled={busy || !requirement.trim() || !projectId || (mode === 'existing' && !sessionId) || (mode === 'new' && groupMode === 'new' && (!newGroupParent.trim() || !newGroupName.trim()))}
          onClick={submit}
        >{busy ? '…' : (mode === 'new' ? T('custom.send') : T('custom.sendToSession'))}</button>
        {fail && <p className="dsh-wt_customFail">{T('custom.fail')}：{fail}</p>}
      </div>
    </div>
  )
}

/** 单个标签页的内容渲染 */
function PaneTabBody(props: { tab: PaneTab; row: PaneRow; index: number; paneTitle?: string; reloadKey: number }) {
  const content = props.tab.content
  if (content.kind === 'iframe') {
    return <IframePane url={content.url} title={content.title ?? props.tab.title} reloadKey={props.reloadKey} />
  }
  if (content.kind === 'file') {
    return <FileViewer path={content.path} />
  }
  if (content.type === 'browser') return <BrowserPane row={props.row} index={props.index} tabId={props.tab.id} content={content} reloadKey={props.reloadKey} />
  if (content.type === 'anim') return <AnimPane row={props.row} index={props.index} tabId={props.tab.id} content={content} reloadKey={props.reloadKey} />
  if (content.type === 'console') return <ConsolePane />
  if (content.type === 'explorer') return <ExplorerPane row={props.row} index={props.index} />
  if (content.type === 'scm') return <GitPane />
  if (content.type === 'tasks') return <JobsPane />
  if (content.type === 'terminal') return <TerminalPane />
  if (content.type === 'custom') return <CustomPane paneTitle={props.paneTitle ?? ''} row={props.row} index={props.index} />
  return (
    <div className="dsh-wt_paneWip">
      <span className="dsh-wt_paneWipIcon" aria-hidden>{BUILTIN_ICONS[content.type]}</span>
      <span className="dsh-wt_paneWipText">{T('pane.wip')}</span>
    </div>
  )
}

/** 需要标签栏刷新按钮的内容类型：网页类（iframe / 浏览器 / 动画）统一在标签最左放 ↻ */
function refreshableTab(t: PaneTab): boolean {
  const c = t.content
  return c.kind === 'iframe' || (c.kind === 'builtin' && (c.type === 'browser' || c.type === 'anim'))
}

/** 窗内容：标签页模型（无标签 = 6 选 1 选择器；标签可切换/关闭，关完回到选择器）
 *  网页类标签最左侧固定一个 ↻ 刷新按钮（标签名之前），点击重挂载该标签内容。 */
function PaneBody(props: { pane: SplitPane; row: PaneRow; index: number }) {
  const { pane, row, index } = props
  const tabs = pane.tabs ?? []
  const active = Math.min(pane.active ?? 0, Math.max(0, tabs.length - 1))
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({})
  if (tabs.length === 0) {
    return <PanePicker row={row} index={index} />
  }
  const refreshTab = (t: PaneTab) => {
    setReloadKeys((m) => ({ ...m, [t.id]: (m[t.id] ?? 0) + 1 }))
    splitStore.setActiveTab(row, index, t.id)
  }
  // 唯一标签是控制室 → 整个标签栏不渲染（不可关、不可换，标签栏无信息价值；去掉顶部多余标题）
  const singleConsole = tabs.length === 1 && tabs[0].content?.kind === 'builtin' && tabs[0].content.type === 'console'
  return (
    <>
      {!singleConsole && !pane.collapsed && (
      <div className="dsh-wt_tabBar">
        {tabs.map((t, i) => {
          // 控制室标签不可关闭：关掉后窗格变选择器，用户回不到控制室（不可逆操作）
          const locked = t.content?.kind === 'builtin' && t.content.type === 'console'
          return (
          <span
            key={t.id}
            className={'dsh-wt_tab' + (i === active ? ' dsh-wt_tabOn' : '')}
            title={t.title}
            draggable={!locked}
            onDragStart={(e: any) => { dragTab = { row, index, tabId: t.id }; tabDragMoved.current = false; try { e.dataTransfer.effectAllowed = 'move' } catch {} }}
            onDragEnd={() => { dragTab = null; setDropTarget(null); if (tabDragMoved.current) suppressTabClick() }}
            onClick={() => { if (tabClickSuppressed()) return; splitStore.setActiveTab(row, index, t.id) }}
          >
            {refreshableTab(t) && (
              <button
                type="button"
                className="dsh-wt_tabRefresh"
                title={T('pane.refresh')}
                aria-label={T('pane.refresh')}
                onClick={(e) => { e.stopPropagation(); refreshTab(t) }}
              >↻</button>
            )}
            <span className="dsh-wt_tabTitle">{t.title}</span>
            {!locked && (
              <button
                type="button"
                className="dsh-wt_tabClose"
                title={T('pane.closeTab')}
                onClick={(e) => { e.stopPropagation(); splitStore.closeTab(row, index, t.id) }}
              >✕</button>
            )}
          </span>
          )
        })}
      </div>
      )}
      {/* 标签页常驻：切换标签只切显隐，不卸载。
          此前只渲染 tabs[active] —— 卸载 iframe 就是整页重载，对一个几百 KB JS 的站点
          等于每次切回来都从头加载一遍，卡就卡在这。
          代价（已知上限）：打开过的每个标签都留在内存里继续跑；标签特别多时吃内存。
          真观测到内存问题再加懒加载/上限，现在不加。 */}
      {tabs.map((t, i) => (
        <div
          key={t.id}
          className="dsh-wt_tabBody"
          data-tab-active={i === active ? 'true' : 'false'}
          style={{ display: i === active ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}
        >
          <PaneTabBody tab={t} row={row} index={index} paneTitle={pane.title} reloadKey={reloadKeys[t.id] ?? 0} />
        </div>
      ))}
    </>
  )
}

/** 未指派内容：4 选 1 选择器。按钮固定大小、整体居中；
 * 按窗位宽高比自适应排列：宽窗横排 4 连 / 方窗 2×2 / 竖窗竖排。 */
function PanePicker(props: { row: PaneRow; index: number }) {
  const [mode, setMode] = useState<'row' | 'grid' | 'col'>('grid')
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      const aspect = h > 0 ? w / h : 1
      setMode(aspect > 1.4 ? 'row' : aspect > 0.72 ? 'grid' : 'col')
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const pick = (content: SplitContent) => splitStore.openTab(props.row, props.index, content)
  return (
    <div ref={hostRef} className={'dsh-wt_panePicker dsh-wt_panePicker-' + mode}>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'browser' })}>
        <span aria-hidden>🌐</span>{T('pane.browser')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'anim' })}>
        <span aria-hidden>🎬</span>{T('pane.anim')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'explorer' })}>
        <span aria-hidden>📁</span>{T('pane.explorer')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'terminal' })}>
        <span aria-hidden>▸_</span>{T('pane.terminal')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'custom' })}>
        <span aria-hidden>✨</span>{T('pane.custom')}
      </button>
    </div>
  )
}

/** 窗格右键菜单：右键内容窗 → 在此窗口新建/添加各类窗口（标签页）、标注、关闭当前标签 */
function CtxMenu() {
  const [, setTick] = useState(0)
  useEffect(() => subscribeCtx(() => setTick((t) => t + 1)), [])
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e?: Event) => {
      const t = e && e.target instanceof Element ? e.target : null
      if (t && t.closest('.dsh-wt_ctxMenu')) return
      setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])
  if (!ctxMenu) return null
  const { row, index } = ctxMenu
  const spec = splitStore.spec
  const pane = row === 'left' ? spec?.left : row === 'top' ? spec?.top?.[index] : spec?.main?.[index]
  const activeTab = pane?.tabs?.[pane.active ?? 0]
  const locked = activeTab?.content?.kind === 'builtin' && activeTab.content.type === 'console'
  const left = Math.min(ctxMenu.x, Math.max(8, window.innerWidth - 210))
  const top = Math.min(ctxMenu.y, Math.max(8, window.innerHeight - 240))
  const act = (fn: () => void) => { setCtxMenu(null); fn() }
  const add = (c: SplitContent) => act(() => splitStore.openTab(row, index, c))
  return (
    <div className="dsh-wt_ctxMenu dsh-wt_annotUi" style={{ position: 'fixed', left, top, zIndex: 5005 }}
      onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="dsh-wt_ctxHead">{windowLabelOf(row, index)}</div>
      <button type="button" className="dsh-wt_ctxItem" onClick={() => add({ kind: 'builtin', type: 'browser' })}><span aria-hidden>🌐</span>{T('pane.browser')}</button>
      <button type="button" className="dsh-wt_ctxItem" onClick={() => add({ kind: 'builtin', type: 'anim' })}><span aria-hidden>🎬</span>{T('pane.anim')}</button>
      <button type="button" className="dsh-wt_ctxItem" onClick={() => add({ kind: 'builtin', type: 'explorer' })}><span aria-hidden>📁</span>{T('pane.explorer')}</button>
      <button type="button" className="dsh-wt_ctxItem" onClick={() => add({ kind: 'builtin', type: 'terminal' })}><span aria-hidden>▸_</span>{T('pane.terminal')}</button>
      <button type="button" className="dsh-wt_ctxItem" onClick={() => add({ kind: 'builtin', type: 'custom' })}><span aria-hidden>✨</span>{T('pane.custom')}</button>
      <div className="dsh-wt_ctxSep" aria-hidden />
      {/* 布局随时修改：结构性拆分/关闭（VSCode 语义；左列整高单窗不支持） */}
      {row !== 'left' && (
        <>
          <button type="button" className="dsh-wt_ctxItem" onClick={() => act(() => { splitStore.splitPane(row, index, 'right') })}><span aria-hidden>◫</span>{T('pane.splitRight')}</button>
          <button type="button" className="dsh-wt_ctxItem" onClick={() => act(() => { splitStore.splitPane(row, index, 'down') })}><span aria-hidden>◱</span>{T('pane.splitDown')}</button>
          {(row === 'top' ? (spec?.top?.length ?? 0) : (spec?.main?.length ?? 0)) > 1 && (
            <button type="button" className="dsh-wt_ctxItem" onClick={() => act(() => { splitStore.closePane(row, index) })}><span aria-hidden>⊘</span>{T('pane.closePane')}</button>
          )}
        </>
      )}
      <div className="dsh-wt_ctxSep" aria-hidden />
      <button type="button" className="dsh-wt_ctxItem" onClick={() => act(() => startAnnot(windowLabelOf(row, index)))}><span aria-hidden>📌</span>{T('annot.label')}</button>
      {activeTab && !locked && (
        <button type="button" className="dsh-wt_ctxItem" onClick={() => act(() => splitStore.closeTab(row, index, activeTab.id))}><span aria-hidden>✕</span>{T('pane.closeTab')}</button>
      )}
    </div>
  )
}

/** 窗口清单（供对话感知工作台现状，避免重复造轮子）：
 *  按「左栏 → 顶行 → 主行」顺序编号（与 windowLabelOf / 标注协议一致），
 *  输出每个窗的编号、标题、当前标签及内容类型。 */
export function buildWindowInventory(spec: LayoutSpec | null): string[] {
  if (!spec) return []
  const out: string[] = []
  const describe = (c: SplitContent | null | undefined): string => {
    if (!c) return '空（未指派，显示选择器）'
    if (c.kind === 'iframe') return c.url ? '网页 ' + (safeHost(c.url) ?? c.url) : '网页（无 URL）'
    if (c.kind === 'file') return '文件 ' + basenameOf(c.path)
    if (c.kind === 'builtin') {
      if (c.type === 'browser') return '浏览器窗' + (c.url ? '（' + (safeHost(c.url) ?? '') + '）' : '')
      if (c.type === 'terminal') return '终端窗'
      if (c.type === 'explorer') return '资源管理器'
      if (c.type === 'custom') return '自定义任务窗'
      if (c.type === 'anim') return '动画站' + (c.url ? '（' + (safeHost(c.url) ?? '') + '）' : '')
      if (c.type === 'console') return '控制室'
      return c.type
    }
    return '未知内容'
  }
  const rows: { row: PaneRow; index: number; pane: SplitPane | undefined }[] = []
  if (spec.left) rows.push({ row: 'left', index: 0, pane: spec.left })
  ;(spec.top ?? []).forEach((p, i) => rows.push({ row: 'top', index: i, pane: p }))
  ;(spec.main ?? []).forEach((p, i) => rows.push({ row: 'main', index: i, pane: p }))
  for (const { row, index, pane } of rows) {
    if (!pane) continue
    const tabs = pane.tabs ?? []
    const active = pane.active ?? 0
    const num = windowNumberOf(spec, row, index)
    const title = pane.title ? '「' + pane.title + '」' : ''
    const extra = tabs.length > 1 ? '（' + tabs.length + ' 个标签，当前第 ' + (active + 1) + ' 个）' : ''
    const cur = tabs[active]
    out.push('窗口' + num + title + extra + '：' + describe(cur?.content))
  }
  return out
}

/** 窗格标题栏状态小字（借鉴 DSH-P「面板通用能力」§4：把绑定对象变成看得见）。
 *  只描述「当前装的是什么」，不读运行时错误——错误由各窗自己的错误区负责。 */
export function paneStatusSub(c: SplitContent | null | undefined): string {
  if (!c) return ''
  if (c.kind === 'iframe') return c.url ? '网页 ' + (safeHost(c.url) ?? c.url) : '网页（无 URL）'
  if (c.kind === 'file') return '文件 ' + basenameOf(c.path)
  if (c.kind === 'builtin') {
    if (c.type === 'browser') return c.url ? '浏览器 ' + (safeHost(c.url) ?? c.url) : '浏览器（未导航）'
    if (c.type === 'anim') return c.url ? '动画站 ' + (safeHost(c.url) ?? c.url) : '动画站'
    if (c.type === 'terminal') return '终端'
    if (c.type === 'explorer') return '资源管理器'
    if (c.type === 'custom') return '自定义任务'
    if (c.type === 'console') return '控制室'
    return c.type
  }
  return ''
}

/** 窗格编号（与 windowLabelOf 同一约定：左栏→顶行→主行，从 1 起） */
function windowNumberOf(spec: LayoutSpec, row: PaneRow, index: number): number {
  let num = spec.left ? 2 : 1
  if (row === 'left') num = 1
  else if (row === 'top') num = num + index
  else num += (spec.top?.length ?? 0) + index
  return num
}

function safeHost(u: string): string | null {
  try { return new URL(u).hostname } catch { return null }
}

/** 拆分出的新窗格标题：
 *  默认「窗口N」命名的窗格返回空标题 —— 由 windowLabelOf 按位置自动编号（与新建布局的窗口一致，不产生「窗口1 2」这种叠加）；
 *  用户自定义过的标题才加「(2)」式后缀，且避开同行已占用的名字。 */
function paneTitleFor(arr: SplitPane[], i: number): string {
  const base = (arr[i]?.title ?? '').trim()
  if (!base || /^窗口\d+$/.test(base)) return ''
  const used = new Set(arr.map((p) => (p.title ?? '').trim()))
  for (let n = 2; n < 20; n++) {
    const candidate = base + ' (' + n + ')'
    if (!used.has(candidate)) return candidate
  }
  return base + ' (' + arr.length + ')'
}

type PoolItem = { spec: LayoutSpec; chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[]; lastActiveAt: number }

/** 保活策略：活跃 + 最近用过 + 正在运行的工作台保留挂载（切回秒开、iframe/滚动不丢）；
 *  长时间不用的卸载（省内存）；首次打开才挂载（懒加载）。 */
const POOL_CAP = 12
const IDLE_KEEP_MS = 3 * 60 * 1000

/** 单个工作区渲染层（geom 为 null 时用 0 几何渲染，外层 display:none 保活，保留网页/MD 滚动/激活标签等状态） */
function WorkspaceLayer(props: { spec: LayoutSpec; geom: Geom | null; chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[] }) {
  const g = props.geom ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const spec = props.spec
  const top = spec.top ?? []
  const main = spec.main ?? []
  const hasLeft = !!spec.left
  const hasTop = top.length > 0
  const chatLeft = !hasLeft && spec.chatSide === 'left'
  const colW = g.right - g.left
  const rowH = g.bottom - g.top
  const chatW = clamp(props.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
  const topH = hasTop
    ? clamp(props.topH, spec.topHeight?.min ?? 80, Math.max(spec.topHeight?.min ?? 80, rowH - BAR_H - 80))
    : 0
  const leftW = hasLeft
    ? clamp(props.leftW, spec.leftWidth?.min ?? 160, Math.max(spec.leftWidth?.min ?? 160, colW - 260))
    : 0
  const chatFull = spec.chatFullHeight === true
  const contentW = Math.max(0, colW - chatW)
  const contentX = hasLeft ? g.left + leftW : (chatLeft ? g.left + chatW : g.left)
  const topRowX = hasLeft ? g.left + leftW : contentX
  const topRowW = hasLeft ? Math.max(0, colW - leftW) : (chatFull ? contentW : colW)

  const topItems = allocate(top, props.topWs, topRowW)
  const mainItems = allocate(main, props.paneWs, contentW)
  const leftItem = spec.left ? { pane: spec.left, left: 0, width: leftW } : null

  const barTop = g.top
  const bodyTop = barTop + BAR_H + topH
  const paneBottom = g.bottom
  const mainH = paneBottom - bodyTop
  const topY = barTop + BAR_H

  const renderPane = (it: { pane: SplitPane; left: number; width: number }, row: PaneRow, index: number, x: number, y: number, h: number) => {
    const singleConsole = (it.pane.tabs ?? []).length === 1 && it.pane.tabs![0].content?.kind === 'builtin' && it.pane.tabs![0].content.type === 'console'
    return (
    <div
      key={it.pane.id}
      className="dsh-wt_pane"
      data-drop-hover={dropTarget && dropTarget.row === row && dropTarget.index === index ? 'true' : undefined}
      style={{ position: 'fixed', left: x + it.left, top: y, width: it.width, height: h, zIndex: 68 }}
      onContextMenu={(e: any) => {
        if (annotState.on) return
        const el = e.target as HTMLElement | null
        if (el && el.closest && el.closest('.dsh-wt_ctxMenu')) return
        e.preventDefault()
        e.stopPropagation()
        setCtxMenu({ x: e.clientX, y: e.clientY, row, index })
      }}
      onDragOver={(e: any) => {
        if (!dragTab) return
        e.preventDefault()
        setDropTarget({ row, index })
      }}
      onDragLeave={(e: any) => {
        if (e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) setDropTarget(null)
      }}
      onDrop={(e: any) => {
        e.preventDefault()
        const s = dragTab
        dragTab = null
        setDropTarget(null)
        if (s && (s.row !== row || s.index !== index)) {
          splitStore.moveTab(s.row, s.index, s.tabId, row, index)
        }
      }}
    >
      {!it.pane.collapsed && (
      <div
        className="dsh-wt_paneBar"
        title={T('split.dragSwap')}
        draggable
        onDragStart={(e: any) => { dragPane = { row, index }; try { e.dataTransfer.effectAllowed = 'move' } catch {} }}
        onDragOver={(e: any) => e.preventDefault()}
        onDrop={(e: any) => {
          e.preventDefault()
          const s = dragPane
          if (s && (s.row !== row || s.index !== index)) splitStore.swapPanes(s.row, s.index, row, index)
          dragPane = null
        }}
        onDragEnd={() => { dragPane = null }}
      >
        <span className="dsh-wt_paneTitle">{it.pane.title || ('窗口' + (spec ? windowNumberOf(spec, row, index) : ''))}</span>
        {/* 状态小字（借鉴 DSH-P「面板通用能力」§4）：把当前绑定对象写在标题行，
            用户不开控制台就能判断「这个窗现在装的是什么」——静默失败最难排查。 */}
        {(() => {
          const tabs = it.pane.tabs ?? []
          const cur = tabs[it.pane.active ?? 0]
          const sub = paneStatusSub(cur?.content)
          return sub ? <span className="dsh-wt_paneSub" title={sub}>{sub}</span> : null
        })()}
      </div>
      )}
      <PaneBody pane={it.pane} row={row} index={index} />
      {!singleConsole && (
        <>
        <button
          type="button"
          className="dsh-wt_annotBtn"
          title={T('annot.label')}
          aria-label={T('annot.label')}
          onClick={() => startAnnot(windowLabelOf(row, index))}
        >
          <svg viewBox="0 0 16 16" aria-hidden><path d="M2 5.6c0-1.2 1-2.2 2.2-2.2h7.6c1.2 0 2.2 1 2.2 2.2v3.6c0 1.2-1 2.2-2.2 2.2H7.5L5 13.6l.3-2.4H4.2c-1.2 0-2.2-1-2.2-2.2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        </button>
        <button
          type="button"
          className={'dsh-wt_collapseBtn' + (it.pane.collapsed ? ' dsh-wt_collapseBtnCollapsed' : '')}
          title={it.pane.collapsed ? T('pane.expand') : T('pane.collapse')}
          aria-label={it.pane.collapsed ? T('pane.expand') : T('pane.collapse')}
          onClick={() => splitStore.toggleCollapsed(row, index)}
        >
          {it.pane.collapsed ? (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </button>
        </>
      )}
    </div>
    )
  }

  return (
    <>
      {/* 标题栏 */}
      <div className="dsh-wt_splitBar" style={{ position: 'fixed', left: g.left, top: barTop, width: hasLeft || chatFull ? contentW : (hasTop ? colW : contentW), zIndex: 70 }}>
        {spec.id !== 'wt-console' && <span className="dsh-wt_splitTitle">{spec.title}</span>}
        {!hasLeft && (
          <button
            type="button"
            className="dsh-wt_splitFlip"
            title={T('split.flip')}
            onClick={() => splitStore.setChatSide(chatLeft ? 'right' : 'left')}
          >⇄</button>
        )}
        <button type="button" className="dsh-wt_splitClose" aria-label="退出分栏（Esc）" onClick={() => splitStore.close()}>✕</button>
      </div>
      {/* 左列整高内容窗 */}
      {leftItem && renderPane(leftItem, 'left', 0, g.left, barTop + BAR_H, g.bottom - barTop - BAR_H)}
      {/* 顶部通栏行（左列布局时为右侧列顶行） */}
      {hasTop && topItems.map((it, i) => renderPane(it, 'top', i, topRowX, topY, topH))}
      {/* 主行内容窗 */}
      {mainItems.map((it, i) => renderPane(it, 'main', i, contentX, bodyTop, mainH))}
      {/* 顶部/主行水平分隔线 */}
      {hasTop && (
        <div
          className="dsh-wt_splitDivider dsh-wt_splitDividerH"
          role="separator"
          title="拖动调整上下分区"
          style={{ position: 'fixed', left: topRowX, top: bodyTop - DIVIDER / 2, width: topRowW, height: DIVIDER, zIndex: 72 }}
          onPointerDown={makeDividerHandler('top')}
        />
      )}
      {/* 顶部行内垂直分隔线 */}
      {hasTop && topItems.slice(0, -1).map((it, i) => (
        <div
          key={'tv' + it.pane.id}
          className="dsh-wt_splitDivider"
          role="separator"
          title="拖动调整宽度"
          style={{ position: 'fixed', left: topRowX + it.left + it.width - DIVIDER / 2, top: topY, width: DIVIDER, height: topH, zIndex: 72 }}
          onPointerDown={makeDividerHandler('topPane', i)}
        />
      ))}
      {/* 主行内容窗垂直分隔线 */}
      {mainItems.slice(0, -1).map((it, i) => (
        <div
          key={'v' + it.pane.id}
          className="dsh-wt_splitDivider"
          role="separator"
          title="拖动调整宽度"
          style={{ position: 'fixed', left: contentX + it.left + it.width - DIVIDER / 2, top: bodyTop, width: DIVIDER, height: mainH, zIndex: 72 }}
          onPointerDown={makeDividerHandler('pane', i)}
        />
      ))}
      {/* 聊天分隔线（左列布局 = 左/右列边界；其余 = 内容与聊天之间） */}
      <div
        className="dsh-wt_splitDivider"
        role="separator"
        title={hasLeft ? '拖动调整左右列宽' : '拖动调整聊天宽度'}
        style={{
          position: 'fixed',
          left: (hasLeft ? g.left + leftW : (chatLeft ? g.left + chatW : g.right - chatW)) - DIVIDER / 2,
          top: hasLeft || chatFull ? barTop + BAR_H : bodyTop,
          width: DIVIDER,
          height: hasLeft || chatFull ? g.bottom - barTop - BAR_H : mainH,
          zIndex: 72,
        }}
        onPointerDown={makeDividerHandler(hasLeft ? 'left' : 'chat')}
      />
      <AnnotationOverlay />
      <CtxMenu />
    </>
  )
}

/** 分栏工作区浮层（shell.overlay 座位；订阅 splitStore 快照渲染）。
 * 切换项目时旧工作区不销毁：全部挂载在池中、仅当前可见（display:none 保活），
 * 网页子页面/滚动位置、MD 滚动位置、激活标签等在切回时原样保留。 */
function SplitWorkspace() {
  const [snap, setSnap] = useState({
    active: splitStore.active,
    spec: splitStore.spec,
    geom: splitStore.geom,
    chatW: splitStore.chatW,
    topH: splitStore.topH,
    leftW: splitStore.leftW,
    paneWs: [...splitStore.paneWs],
    topWs: [...splitStore.topWs],
  })
  const poolRef = useRef<Map<string, PoolItem>>(new Map())
  const [, setPoolTick] = useState(0)

  useEffect(() => splitStore.subscribe(() => {
    const spec = splitStore.spec
    if (splitStore.active && spec) {
      const prevItem = poolRef.current.get(spec.id)
      poolRef.current.set(spec.id, {
        spec,
        chatW: splitStore.chatW,
        topH: splitStore.topH,
        leftW: splitStore.leftW,
        paneWs: [...splitStore.paneWs],
        topWs: [...splitStore.topWs],
        lastActiveAt: Date.now(),
      })
      // 内存上限（LRU）：活跃 + 正在运行的永不淘汰，其余按最近使用淘汰
      while (poolRef.current.size > POOL_CAP) {
        const activeId0 = splitStore.spec?.id
        let victim: string | null = null
        let oldest = Infinity
        for (const [id, it] of poolRef.current) {
          if (id === activeId0) continue
          if (splitEnv?.isProjectRunning?.(id)) continue
          if (it.lastActiveAt < oldest) { oldest = it.lastActiveAt; victim = id }
        }
        if (victim == null) break
        poolRef.current.delete(victim)
      }
    }
    setSnap({
      active: splitStore.active,
      spec: splitStore.spec,
      geom: splitStore.geom,
      chatW: splitStore.chatW,
      topH: splitStore.topH,
      leftW: splitStore.leftW,
      paneWs: [...splitStore.paneWs],
      topWs: [...splitStore.topWs],
    })
    setPoolTick((t) => t + 1)
  }), [])

  useEffect(() => {
    if (!snap.active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') splitStore.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snap.active])

  // 标签拖放高亮 → 重渲染
  const [, setDropTick] = useState(0)
  useEffect(() => {
    const fn = () => setDropTick((t) => t + 1)
    dropTargetListeners.add(fn)
    return () => { dropTargetListeners.delete(fn) }
  }, [])

  // 空闲回收：长时间不用且非运行中的工作台卸载（省内存）；active 与运行中永不回收
  useEffect(() => {
    const iv = window.setInterval(() => {
      const activeId0 = splitStore.active && splitStore.spec ? splitStore.spec.id : null
      const now = Date.now()
      let changed = false
      for (const [id, it] of Array.from(poolRef.current)) {
        if (id === activeId0) continue
        if (splitEnv?.isProjectRunning?.(id)) continue
        if (now - it.lastActiveAt > IDLE_KEEP_MS) { poolRef.current.delete(id); changed = true }
      }
      if (changed) setPoolTick((t) => t + 1)
    }, 30000)
    return () => window.clearInterval(iv)
  }, [])

  const activeId = snap.active && snap.spec ? snap.spec.id : null
  const entries = Array.from(poolRef.current.entries())
  if (entries.length === 0) return null
  return (
    <>
      {entries.map(([id, item]) => {
        const isActive = id === activeId
        return (
          <div key={id} style={isActive ? undefined : { visibility: 'hidden' as const }}>
            <WorkspaceLayer
              spec={item.spec}
              geom={isActive ? snap.geom : null}
              chatW={isActive ? snap.chatW : item.chatW}
              topH={isActive ? snap.topH : item.topH}
              leftW={isActive ? snap.leftW : item.leftW}
              paneWs={isActive ? snap.paneWs : item.paneWs}
              topWs={isActive ? snap.topWs : item.topWs}
            />
          </div>
        )
      })}
    </>
  )
}

/** 调试出口（自动化验证用；必须在 store 定义之后） */
try { (window as any).__dshWorktable = { splitStore } } catch {}

export { SplitWorkspace }
