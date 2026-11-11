import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TeamApiProvider, useTeamApi } from './api.ts'
import { prefix } from '../shared/paths.ts'
import type { AgentRun, Conversation, ImEvent, Member, Message } from '../shared/protocol.ts'
import { Avatar, Brand, NativeChrome, NativeMessage, NativeSettings, useBotAppearance } from './native.jsx'
import { usePersonalRuns } from './personal.tsx'
import type { PersonalBot, PersonalExecutor } from './personal.tsx'
import { ArrowUpIcon, ConnectorIcon, GearIcon, MonitorIcon, PeopleIcon, PlusIcon, PlugIcon, SearchIcon } from '../../ds-bot/src/client/icons.js'
import { allThemes } from '../../ds-bot/src/client/themes.js'

type NativeWorkspace = {
  bots: PersonalBot[]
  open: (page: string, botId?: string) => void
  execute: PersonalExecutor
  target?: HTMLElement | null
  visible: boolean
  command?: { type: 'create' } | null
  reveal: () => void
  consumeCommand: (command: { type: 'create' }) => void
}

type Me = { id: string; name: string; username: string; admin: boolean; personalWorkspace?: string | null }
type Run = AgentRun & { actionable: boolean; can_approve?: boolean }
type Draft = { text: string; mentions: Member[]; files: File[]; quote: Message | null }
type Pending = { room: string; clientMessageId: string; draft: Draft; attachments: string[] }
type Desktop = {
  notify: (body: { title: string; body: string; conversation: string }) => void
  badge: (count: number) => void
  onOpen: (callback: (id: string) => void) => () => void
  settings: () => void
}
const desktop = (window as Window & { teamDesktop?: Desktop }).teamDesktop
const empty = (): Draft => ({ text: '', mentions: [], files: [], quote: null })
const merge = (a: Message[], b: Message[]) =>
  [...new Map([...a, ...b].map((m) => [m.id, m])).values()].sort((x, y) =>
    Number(BigInt(x.seq) - BigInt(y.seq))
  )
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const loginAppearance = { theme: 'deepseek', layout: 'bubble' }

function Login({ onLogin }: { onLogin: () => void }) {
  const { api, embedded } = useTeamApi()
  useBotAppearance(loginAppearance, !embedded)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const query = new URLSearchParams(location.hash.slice(1))
  const invite = query.get('invite'),
    reset = query.get('reset')
  return (
    <main className="login">
      <div className="login-card">
        <Brand />
        <h1>{reset ? '重置密码' : invite ? '加入团队' : '登录团队'}</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError('')
            const form = new FormData(e.currentTarget)
            try {
              await api(invite || reset ? '/accept' : '/login', 'POST', {
                ...Object.fromEntries(form),
                ...(invite || reset ? { token: invite ?? reset } : {}),
              })
              if (invite || reset) history.replaceState({}, '', location.pathname)
              onLogin()
            } catch (error) {
              setError(errorText(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          {!reset && (
            <label>
              用户名
              <input name="username" autoComplete="username" required />
            </label>
          )}
          {invite && (
            <label>
              显示名称
              <input name="name" required maxLength={100} />
            </label>
          )}
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete={invite || reset ? 'new-password' : 'current-password'}
              minLength={invite || reset ? 12 : undefined}
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? '正在提交…' : invite ? '加入' : reset ? '保存密码' : '登录'}
          </button>
        </form>
        {desktop && (
          <button className="quiet" onClick={desktop.settings}>
            更改服务器
          </button>
        )}
      </div>
    </main>
  )
}
function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog className="team-dialog" ref={ref} onCancel={close}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  )
}
function Admin({
  agents,
  people,
  reload,
  call,
}: {
  agents: Member[]
  people: Member[]
  reload: () => Promise<void>
  call: (f: () => Promise<unknown>) => Promise<void>
}) {
  const { api } = useTeamApi()
  const [link, setLink] = useState('')
  const [model, setModel] = useState('')
  const [log, setLog] = useState<
    { id: string; status: string; outcome: string; agent: string | null; duration_ms: string | null }[]
  >([])
  const [editing, setEditing] = useState<Member | null>(null)
  useEffect(() => {
    void call(async () => setModel((await api<{ routerModel: string }>('/admin/settings')).routerModel))
  }, [])
  return (
    <div className="admin">
      <h3>团队成员</h3>
      <button
        className="primary"
        onClick={() =>
          void call(async () => setLink((await api<{ url: string }>('/admin/invitations', 'POST', {})).url))
        }
      >
        生成邀请链接
      </button>
      {link && (
        <div className="invite">
          <input aria-label="邀请或重置链接" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button onClick={() => void call(() => navigator.clipboard.writeText(link))}>复制</button>
        </div>
      )}
      {people.map((p) => (
        <div className="person-row" key={p.id}>
          <Avatar id={p.id} name={p.name} />
          <span>{p.name}</span>
          {p.admin ? (
            <small>管理员</small>
          ) : (
            <div className="row-actions">
              <button
                onClick={() =>
                  void call(async () => {
                    await api('/admin/users/' + p.id, 'PATCH', { active: !p.active })
                    await reload()
                  })
                }
              >
                {p.active ? '停用' : '恢复'}
              </button>
              {p.active && (
                <button
                  onClick={() =>
                    void call(async () =>
                      setLink(
                        (await api<{ url: string }>('/admin/invitations', 'POST', { resetUser: p.id })).url
                      )
                    )
                  }
                >
                  重置密码
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <h3>服务器 Agent</h3>
      {agents.map((p) => (
        <div className="person-row" key={p.id}>
          <Avatar id={p.id} name={p.name} agent />
          <span>
            {p.name}
            {!p.active ? ' · 已停用' : ''}
          </span>
          <button onClick={() => setEditing(p)}>编辑</button>
        </div>
      ))}
      <button onClick={() => setEditing({ id: '', name: '', kind: 'agent' })}>新建 Agent</button>
      {editing && (
        <form
          key={editing.id}
          onSubmit={(e) => {
            e.preventDefault()
            const form = new FormData(e.currentTarget)
            void call(async () => {
              await api('/admin/agents' + (editing.id ? '/' + editing.id : ''), editing.id ? 'PUT' : 'POST', {
                name: form.get('name'),
                description: form.get('description'),
                instructions: form.get('instructions'),
                model: form.get('model'),
                tools: form.has('tools'),
                active: form.has('active'),
              })
              setEditing(null)
              await reload()
            })
          }}
        >
          <label>
            名称
            <input name="name" required defaultValue={editing.name} />
          </label>
          <label>
            能力说明
            <input name="description" defaultValue={editing.description} />
          </label>
          <label>
            指令
            <textarea name="instructions" defaultValue={editing.instructions} />
          </label>
          <label>
            DSH 模型
            <input
              name="model"
              required
              placeholder="deepseek-official/模型 ID"
              defaultValue={editing.model}
            />
          </label>
          <label className="check">
            <input type="checkbox" name="tools" defaultChecked={editing.tools} />
            允许处理与生成文件
          </label>
          <label className="check">
            <input type="checkbox" name="active" defaultChecked={editing.active ?? true} />
            启用
          </label>
          <button className="primary">保存 Agent</button>
        </form>
      )}
      <h3>Super Agent</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void call(() => api('/admin/settings', 'PUT', { routerModel: model }))
        }}
      >
        <label>
          快速分类模型 ID
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="配置的分类服务中的模型 ID"
          />
        </label>
        <button className="primary">保存模型</button>
      </form>
      <button onClick={() => void call(async () => setLog(await api('/admin/routing-log')))}>
        查看调度记录
      </button>
      {log.length > 0 && (
        <ul>
          {log.map((l) => (
            <li key={l.id}>
              {l.outcome ?? l.status}
              {l.agent ? ' · ' + l.agent : ''}
              {l.duration_ms ? ' · ' + Math.round(Number(l.duration_ms)) + ' ms' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SidebarContacts({ workspace, children }: { workspace?: NativeWorkspace; children: React.ReactNode }) {
  if (!workspace?.target) return null
  return createPortal(children, workspace.target)
}

function Chat({ me, logout, workspace }: { me: Me; logout: () => void; workspace?: NativeWorkspace }) {
  const { api, origin, embedded } = useTeamApi()
  const visible = workspace?.visible ?? true
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const native = me.personalWorkspace === location.origin ? workspace : undefined
  const hasPersonal = Boolean(native)
  const personalBots = native?.bots ?? []
  const awaiting = usePersonalRuns(Boolean(native), native?.execute)
  function openPersonal(page = 'home', botId?: string) {
    setModal('')
    setPanel(false)
    native?.open(page, botId)
  }
  const [rooms, setRooms] = useState<Conversation[]>([])
  const [people, setPeople] = useState<Member[]>([]),
    [agents, setAgents] = useState<Member[]>([])
  const [roomId, setRoom] = useState<string>()
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [draft, setDraft] = useState<Draft>(empty)
  const [pending, setPending] = useState<Pending | null>(null)
  const [sending, setSending] = useState(false)
  const [modal, setModal] = useState('')
  const [settingsPage, setSettingsPage] = useState('team-profile')
  const [prefs, setPrefs] = useState<{ theme: string; layout: 'bubble' | 'flat' }>(() => {
    try { return JSON.parse(localStorage.getItem('team:appearance') ?? 'null') ?? { theme: 'deepseek', layout: 'bubble' } }
    catch { return { theme: 'deepseek', layout: 'bubble' } }
  })
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [runnerOnline, setRunnerOnline] = useState<boolean>()
  const [older, setOlder] = useState(true)
  const [search, setSearch] = useState<Message[] | null>(null)
  const [picks, setPicks] = useState<string[]>([])
  const [panel, setPanel] = useState(false)
  const [mentions, setMentions] = useState(false)
  const [focusMessage, setFocusMessage] = useState('')
  const [notifications, setNotifications] = useState(false)
  const messagesEl = useRef<HTMLDivElement>(null)
  const roomRef = useRef<string | undefined>(undefined)
  const active = rooms.find((r) => r.id === roomId)
  const owner = active?.kind === 'group' && active.owner_id === me.id
  const bottom = useRef(true)
  const notificationsRef = useRef(false)
  const stateVersion = useRef(0)
  const loadVersion = useRef(0)
  const lastSeq = useRef<string | undefined>(undefined)
  async function call(fn: () => Promise<unknown>) {
    setError('')
    try {
      await fn()
    } catch (error) {
      if ((error as { status?: number }).status === 401) logout()
      else setError(errorText(error))
    }
  }
  async function reload() {
    const [p, a] = await Promise.all([api<Member[]>('/people'), api<Member[]>('/agents')])
    setPeople(p)
    setAgents(a)
  }
  async function list() {
    const result = await api<Conversation[]>('/conversations')
    setRooms(result)
    desktop?.badge(result.reduce((sum, r) => sum + r.unread, 0))
    if (roomRef.current && !result.some((r) => r.id === roomRef.current)) open(undefined)
  }
  function open(id: string | undefined) {
    if (roomRef.current === id) return
    roomRef.current = id
    stateVersion.current++
    lastSeq.current = undefined
    setRoom(id)
    setMessages([])
    setMembers([])
    setRuns([])
    setDraft(empty())
    setOlder(true)
    setPanel(false)
    setPending(null)
    setMentions(false)
    setError('')
    bottom.current = true
  }
  async function timeline(id: string, fresh = false, changed: string[] = []) {
    const version = stateVersion.current
    const load = ++loadVersion.current
    let after = lastSeq.current
    const catchUp: Message[] = []
    while (after) {
      const batch = await api<Message[]>('/conversations/' + id + '/messages?after=' + after)
      if (version !== stateVersion.current || load !== loadVersion.current) return
      catchUp.push(...batch)
      if (batch.length < 50) break
      after = batch.at(-1)!.seq
    }
    const [page, roster, tasks, updates] = await Promise.all([
      api<Message[]>('/conversations/' + id + '/messages'),
      api<Member[]>('/conversations/' + id + '/members'),
      api<Run[]>('/conversations/' + id + '/runs'),
      changed.length
        ? api<Message[]>('/conversations/' + id + '/message-updates?ids=' + changed.join(','))
        : Promise.resolve([]),
    ])
    if (roomRef.current !== id || version !== stateVersion.current || load !== loadVersion.current) return
    lastSeq.current = page.at(-1)?.seq
    setMessages((old) => {
      const loaded = merge(old, merge(catchUp, page))
      const visible = new Set(loaded.map((message) => message.id))
      return merge(loaded, updates.filter((message) => visible.has(message.id)))
    })
    setMembers(roster)
    setRuns(tasks)
    if (fresh) setOlder(page.length === 50)
    if (page.length && visibleRef.current && document.visibilityState === 'visible' && bottom.current)
      await api('/conversations/' + id + '/read', 'POST', { seq: page.at(-1)!.seq })
  }
  useEffect(() => {
    void call(async () => {
      await Promise.all([list(), reload()])
    })
    return desktop?.onOpen((id) => open(id))
  }, [])
  useEffect(() => {
    if (roomId) void call(() => timeline(roomId, true))
  }, [roomId, visible])
  useEffect(() => {
    let closed = false
    const refresh = async () => {
      const status = await api<{ online: boolean }>('/runner-status').catch(() => undefined)
      if (!closed) setRunnerOnline(status?.online)
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      closed = true
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    let socket: WebSocket | undefined,
      cursor: string | undefined,
      stopped = false
    let retry: ReturnType<typeof setTimeout>, update: ReturnType<typeof setTimeout> | undefined
    let shouldList = false,
      shouldReload = false,
      shouldTimeline = false,
      syncing = false
    const changed = new Map<string, string>()
    const flush = async () => {
      update = undefined
      if (stopped || syncing) return
      syncing = true
      const flags = [shouldList, shouldReload, shouldTimeline]
      const pendingChanges = new Map(changed)
      changed.clear()
      shouldList = shouldReload = shouldTimeline = false
      try {
        await call(async () => {
          if (flags[0]) await list()
          if (flags[1]) await reload()
          const id = roomRef.current
          if (flags[2] && id) {
            const ids = [...pendingChanges].filter(([, room]) => room === id).map(([message]) => message)
            await timeline(id, false, ids.slice(-100))
          }
        })
      } finally {
        syncing = false
        if (shouldList || shouldReload || shouldTimeline) schedule()
      }
    }
    const schedule = () => {
      if (!update && !stopped) update = setTimeout(() => void flush(), 140)
    }
    const connect = () => {
      const wsUrl = new URL(prefix + '/events', origin)
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      if (cursor) wsUrl.searchParams.set('after', cursor)
      socket = new WebSocket(wsUrl)
      socket.onmessage = (e) => {
        const event = JSON.parse(e.data) as ImEvent
        if (cursor && BigInt(event.id) < BigInt(cursor)) return
        cursor = event.id
        if (event.kind === 'ready') {
          setConnected(true)
          shouldList = shouldTimeline = shouldReload = true
        } else {
          if (event.kind !== 'message.delta') shouldList = true
          shouldReload ||= event.kind === 'directory.updated'
          shouldTimeline ||= Boolean(event.conversation_id && event.conversation_id === roomRef.current)
          if (
            event.conversation_id &&
            event.conversation_id === roomRef.current &&
            event.kind !== 'message.added' &&
            typeof event.data.messageId === 'string'
          ) changed.set(event.data.messageId, event.conversation_id)
          if (
            event.kind === 'message.added' &&
            event.data.authorId !== me.id &&
            event.conversation_id &&
            (!visibleRef.current || event.conversation_id !== roomRef.current || document.visibilityState !== 'visible')
          ) {
            const title = 'DS Bot Team',
              body = '收到一条新消息'
            if (desktop) desktop.notify({ title, body, conversation: event.conversation_id })
            else if (notificationsRef.current && Notification.permission === 'granted')
              new Notification(title, { body })
          }
        }
        schedule()
      }
      socket.onclose = (e) => {
        if (stopped) return
        setConnected(false)
        if (e.code === 1008) {
          logout()
          return
        }
        retry = setTimeout(connect, 1500)
      }
    }
    const visible = () => {
      shouldList = shouldTimeline = true
      schedule()
    }
    document.addEventListener('visibilitychange', visible)
    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      clearTimeout(update)
      socket?.close()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  useEffect(() => {
    if (visible && bottom.current && messagesEl.current) messagesEl.current.scrollTop = messagesEl.current.scrollHeight
  }, [messages, visible])
  useEffect(() => {
    if (focusMessage && messages.some((m) => m.id === focusMessage))
      document.getElementById('m-' + focusMessage)?.scrollIntoView({ block: 'center' })
  }, [focusMessage, messages])

  const newChat = (person: Member) =>
    void call(async () => {
      const result = await api<{ id: string }>('/conversations', 'POST', {
        kind: person.kind === 'agent' ? 'agent' : 'dm',
        target: person.id,
      })
      await list()
      open(result.id)
      setModal('')
    })
  async function post() {
    if (sending || !roomId || (!draft.text.trim() && !draft.files.length && !draft.mentions.length)) return
    const current =
      pending?.room === roomId
        ? pending
        : { room: roomId, clientMessageId: crypto.randomUUID(), draft, attachments: [] }
    setPending(current)
    setSending(true)
    try {
      await call(async () => {
        for (const file of current.draft.files.slice(current.attachments.length)) {
          const form = new FormData()
          form.set('file', file)
          current.attachments.push(
            (await api<{ id: string }>('/conversations/' + current.room + '/files', 'POST', form)).id
          )
        }
        await api('/conversations/' + current.room + '/messages', 'POST', {
          clientMessageId: current.clientMessageId,
          text: [...current.draft.mentions.map((m) => '@' + m.name), current.draft.text]
            .filter(Boolean)
            .join(' '),
          replyId: current.draft.quote?.id,
          mentions: current.draft.mentions.filter((m) => m.id !== 'all').map((m) => m.id),
          mentionAll: current.draft.mentions.some((m) => m.id === 'all'),
          attachments: current.attachments,
        })
        if (roomRef.current === current.room) {
          setDraft(empty())
          setPending(null)
          bottom.current = true
          await timeline(current.room)
        }
        await list()
      })
    } finally {
      setSending(false)
    }
  }
  function patch(payload: unknown) {
    if (!roomId) return
    void call(async () => {
      await api('/conversations/' + roomId, 'PATCH', payload)
      await Promise.all([list(), timeline(roomId)])
    })
  }
  async function loadOlder() {
    if (!roomId || !messages.length) return
    const id = roomId
    await call(async () => {
      const page = await api<Message[]>('/conversations/' + id + '/messages?before=' + messages[0].seq)
      if (roomRef.current !== id) return
      setOlder(page.length === 50)
      const el = messagesEl.current
      const height = el?.scrollHeight ?? 0,
        top = el?.scrollTop ?? 0
      bottom.current = false
      setMessages((old) => merge(page, old))
      requestAnimationFrame(() => {
        if (el) el.scrollTop = top + el.scrollHeight - height
      })
    })
  }
  const memberOptions = [
    ...people.filter((p) => p.id !== me.id && p.active),
    ...agents.filter((p) => p.active && !p.personal),
  ]
  const mentionOptions: Member[] = [
    ...members.filter((m) => m.id !== me.id && m.active),
    ...(active?.kind === 'group' ? [{ id: 'all', name: '所有人', kind: 'user' as const }] : []),
  ]
  useBotAppearance(prefs, !embedded)
  const composerDisabled = Boolean(pending) || sending
  function showModal(next: string) {
    setError('')
    if (next === 'create') setPicks([])
    if (next === 'search') setSearch(null)
    if (next === 'settings') setSettingsPage('team-profile')
    setModal(next)
  }
  useEffect(() => {
    if (workspace?.command?.type === 'create') {
      showModal('create')
      workspace.consumeCommand(workspace.command)
    }
  }, [workspace?.command])
  function fromDirectory(task: () => void) {
    workspace?.reveal()
    task()
  }
  function savePrefs(next: typeof prefs) {
    setPrefs(next)
    localStorage.setItem('team:appearance', JSON.stringify(next))
  }
  return (
    <div className="team-window">
      <SidebarContacts workspace={workspace}>
        <section aria-label="通讯录">
          <div className="bt-team-directory-header">
            <h2>通讯录</h2>
            <button type="button" className="bt-round" title="团队设置" aria-label="团队设置"
              onClick={() => fromDirectory(() => showModal('settings'))}><GearIcon /></button>
          </div>
          {people.filter(person => person.id !== me.id && person.active).map(person =>
            <button type="button" className="bt-row" key={person.id} onClick={() => fromDirectory(() => newChat(person))}>
              <Avatar id={person.id} name={person.name} size={25} />
              <span className="bt-row-name"><span className="bt-row-title">{person.name}</span></span>
            </button>)}
        </section>
        <section aria-label="团队会话">
          <div className="bt-team-directory-header">
            <h2>团队会话</h2>
            <div>
              <button type="button" className="bt-round" title="搜索消息" aria-label="搜索消息"
                onClick={() => fromDirectory(() => showModal('search'))}><SearchIcon /></button>
              <button type="button" className="bt-round" title="新建团队群聊" aria-label="新建团队群聊"
                onClick={() => fromDirectory(() => showModal('create'))}><PlusIcon /></button>
            </div>
          </div>
          {awaiting && <button type="button" className="bt-row"
            onClick={() => fromDirectory(() => open(awaiting))}>个人 Agent 有一条群任务待确认</button>}
          {rooms.map(room =>
            <button type="button" key={room.id} className="bt-row" data-team-room-id={room.id}
              aria-current={visible && active?.id === room.id ? 'page' : undefined}
              onClick={() => fromDirectory(() => { setModal(''); open(room.id) })}>
              <span className="bt-row-body">
                <span className="bt-row-name"><span className="bt-row-title">{room.name}</span></span>
                {room.preview && <span className="bt-row-preview">{room.preview}</span>}
              </span>
              {room.unread > 0 && <span className="bt-team-unread" aria-label={room.unread + ' 条未读'}>{room.unread}</span>}
            </button>)}
        </section>
      </SidebarContacts>
      <main className={embedded ? "dsb-main team-main" : "dsb-main dsb_centerCol team-main"}>
        <NativeChrome rooms={rooms} active={active} people={people} agents={agents}
          members={members} runs={runs} prefs={prefs} panel={panel} open={open}
          showPanel={setPanel} showModal={showModal} personalUrl={hasPersonal} embedded={embedded} />
        {awaiting && !workspace?.target && <button className="bt-soft team-personal-request" onClick={() => open(awaiting)}>个人 Agent 有一条群任务待确认</button>}
        {error && (
          <div className="error banner" role="alert">
            {error}
            <button onClick={() => setError('')} aria-label="关闭提示">
              ×
            </button>
          </div>
        )}
        {active ? (
          <>
            <div className="team-status" role="status">
              {!connected ? '重连中' : members.some((member) => member.kind === 'agent' && !member.personal) && runnerOnline === false
                ? 'Agent 执行器离线' : ''}
            </div>
            <div className="dsb-chat">
            <div
              className="dsb-scroll"
              data-conversation-scroll=""
              ref={messagesEl}
              onScroll={(e) => {
                const t = e.currentTarget
                bottom.current = t.scrollHeight - t.scrollTop - t.clientHeight < 96
                if (visibleRef.current && bottom.current && messages.length && document.visibilityState === 'visible')
                  void api('/conversations/' + active.id + '/read', 'POST', {
                    seq: messages.at(-1)!.seq,
                  }).catch(() => {})
              }}
            >
              <div className="dsb-column dsb-flow" data-chat-flow="">
              {older && messages.length >= 50 && (
                <button className="bt-soft bt-soft-sm older" onClick={() => void loadOlder()}>
                  加载更早消息
                </button>
              )}
              {!messages.length && <div className="empty">发送第一条消息，开始对话。</div>}
              {messages.map((m) => {
                const run = runs.find((r) => r.reply_id === m.id)
                return (
                  <article
                    id={'m-' + m.id}
                    className={'message ' + (focusMessage === m.id ? 'highlight' : '')}
                    key={m.id}
                  >
                    <NativeMessage message={m} mine={m.user_id === me.id}>
                      {m.quote && <blockquote>{m.quote}</blockquote>}
                      {m.attachments.map((f) => (
                        <a key={f.id} className="file" href={origin + prefix + '/files/' + f.id} download={f.name}>
                          {f.media_type.startsWith('image/') && (
                            <img loading="lazy" src={origin + prefix + '/files/' + f.id} alt={f.name} />
                          )}
                          <span>↓ {f.name}</span>
                        </a>
                      ))}
                      {m.status !== 'complete' && (
                        <small className="run-state">
                          {m.status === 'running'
                            ? (run?.progress ?? '正在处理…')
                            : m.status === 'failed'
                              ? '执行失败'
                              : '已取消'}
                        </small>
                      )}
                      {run?.status === 'approval' && run.approval && (
                        <div className="approval">
                          <span>{run.approval.label}</span>
                          {(run.can_approve ?? run.actionable) &&
                            (['allow', 'deny'] as const).map((action) => (
                              <button
                                key={action}
                                onClick={() =>
                                  void call(() =>
                                    api('/runs/' + run.id + '/action', 'POST', {
                                      action,
                                      approvalId: run.approval!.id,
                                    })
                                  )
                                }
                              >
                                {action === 'allow' ? '允许一次' : '拒绝'}
                              </button>
                            ))}
                        </div>
                      )}
                      {run?.actionable && ['running', 'approval'].includes(run.status) && (
                        <button
                          className="quiet"
                          onClick={() =>
                            void call(() => api('/runs/' + run.id + '/action', 'POST', { action: 'cancel' }))
                          }
                        >
                          停止
                        </button>
                      )}
                      <button className="bt-tool team-reply" disabled={composerDisabled}
                        onClick={() => setDraft((d) => ({ ...d, quote: m }))}>引用</button>
                    </NativeMessage>
                  </article>
                )
              })}
              {runs
                .filter((r) => r.status === 'queued')
                .map((run) => (
                  <div className="run-state" key={run.id}>
                    Agent 排队中{' '}
                    {run.actionable && (
                      <button
                        onClick={() =>
                          void call(() => api('/runs/' + run.id + '/action', 'POST', { action: 'cancel' }))
                        }
                      >
                        取消
                      </button>
                    )}
                  </div>
                ))}
              <div data-chat-running="" />
              </div>
            </div>
            <div className="dsb-composer-root">
            <form
              className="dsb-composer-wrap"
              onSubmit={(e) => {
                e.preventDefault()
                void post()
              }}
            >
              {draft.quote && (
                <div className="quote">
                  {draft.quote.sender}：{draft.quote.text.slice(0, 100)}{' '}
                  <button
                    type="button"
                    disabled={composerDisabled}
                    onClick={() => setDraft((d) => ({ ...d, quote: null }))}
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="chips">
                {draft.mentions.map((m) => (
                  <button
                    type="button"
                    disabled={composerDisabled}
                    key={m.id}
                    onClick={() =>
                      setDraft((d) => ({ ...d, mentions: d.mentions.filter((x) => x.id !== m.id) }))
                    }
                  >
                    @{m.name} ×
                  </button>
                ))}
                {draft.files.map((f, i) => (
                  <button
                    type="button"
                    disabled={composerDisabled}
                    key={i}
                    onClick={() => setDraft((d) => ({ ...d, files: d.files.filter((_, j) => j !== i) }))}
                  >
                    {f.name} ×
                  </button>
                ))}
              </div>
              <div className="dsb-composer" data-composer-card="" data-multiline={draft.text.includes('\n') || undefined}>
                <div className="dsb-composer-tools">
                <button type="button" className="bt-round" aria-label="提及" disabled={composerDisabled} onClick={() => setMentions(!mentions)}>
                  @
                </button>
                <label className="bt-round team-upload" title="上传文件">
                  <PlusIcon />
                  <input
                    type="file"
                    aria-label="上传文件"
                    multiple
                    disabled={composerDisabled}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? [])
                      setDraft((d) => ({ ...d, files: [...d.files, ...files].slice(0, 10) }))
                      e.target.value = ''
                    }}
                  />
                </label>
                </div>
                <div className="dsb-composer-input" data-input-scroll="">
              <textarea
                rows={1}
                data-composer-input=""
                aria-label="输入消息"
                placeholder={'发消息给 '+active.name}
                value={draft.text}
                disabled={composerDisabled}
                onChange={(e) => {
                  const text = e.target.value
                  setDraft((d) => ({ ...d, text }))
                  if (text.endsWith('@')) setMentions(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void post()
                  }
                }}
              />
                </div>
                <div className="dsb-composer-trailing">
                  {pending && !sending && <button className="bt-soft" type="button" onClick={() => setPending(null)}>编辑</button>}
                  <button className="dsb-send" aria-label="发送" title={pending ? '重试' : '发送'}
                    disabled={sending || (!draft.text.trim() && !draft.files.length && !draft.mentions.length)}>
                    <ArrowUpIcon />
                  </button>
                </div>
              </div>
              {mentions && (
                <div className="bt-menu mention-menu">
                  {mentionOptions.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => {
                        setDraft((d) =>
                          d.mentions.some((x) => x.id === m.id)
                            ? d
                            : { ...d, text: d.text.replace(/@$/, ''), mentions: [...d.mentions, m] }
                        )
                        setMentions(false)
                      }}
                    >
                      {m.kind === 'agent' ? '✦ ' : ''}
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </form>
            </div>
            </div>
          </>
        ) : embedded ? (
          <div className="empty">从左侧通讯录选择同事，或打开已有会话。</div>
        ) : (
          <div className="empty welcome">
            <h1>团队消息</h1>
            <p>从通讯录发起私聊，或创建一个群聊。</p>
            <button className="bt-soft" onClick={() => showModal('directory')}>
              打开通讯录
            </button>
          </div>
        )}
      </main>
      {panel && active && (
        <aside className="bt-panel details">
          <div className="modal-head">
            <h2>群成员</h2>
            <button onClick={() => setPanel(false)}>×</button>
          </div>
          {owner && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                patch({ name: new FormData(e.currentTarget).get('name') })
              }}
            >
              <label>
                群名称
                <input key={active.name} name="name" defaultValue={active.name} required />
              </label>
              <button>保存</button>
            </form>
          )}
          {members.map((p) => (
            <div className="person-row" key={p.id}>
              <Avatar id={p.id} name={p.name} agent={p.kind === 'agent'} />
              <span>
                {p.name}
                {p.id === active.owner_id ? ' · 群主' : ''}
              </span>
              {owner && p.id !== me.id && (
                <div className="row-actions">
                  {p.kind === 'user' && p.active && (
                    <button onClick={() => patch({ owner: p.id })}>转让</button>
                  )}
                  <button
                    onClick={() =>
                      patch(p.kind === 'user' ? { removeUsers: [p.id] } : { removeAgents: [p.id] })
                    }
                  >
                    移除
                  </button>
                </div>
              )}
            </div>
          ))}
          {owner && (
            <>
              <button
                onClick={() => {
                  setPicks([])
                  setModal('add')
                }}
              >
                添加成员或 Agent
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={active.routing}
                  onChange={(e) => patch({ routing: e.target.checked })}
                />
                Super Agent 自动分派
              </label>
            </>
          )}
        </aside>
      )}
      {modal === 'settings' && <NativeSettings page={settingsPage} setPage={setSettingsPage}
        close={() => setModal('')}
        profile={<><h3>{me.name}</h3>{error && <p className="bt-error" role="alert">{error}</p>}
<div className="settings-row">
                {desktop ? (
                  <button onClick={desktop.settings}>服务器地址</button>
                ) : (
                  <button
                    onClick={() =>
                      void call(async () => {
                        if ('Notification' in window) {
                          const result = await Notification.requestPermission()
                          notificationsRef.current = result === 'granted'
                          setNotifications(result === 'granted')
                        }
                      })
                    }
                  >
                    {notifications ? '浏览器通知已开启' : '开启浏览器通知'}
                  </button>
                )}
                <button
                  onClick={() =>
                    void call(async () => {
                      await api('/logout', 'POST')
                      logout()
                    })
                  }
                >
                  退出登录
                </button>
              </div>
              </>}
        personal={hasPersonal && (
          <div className="team-workspace-links">
            <button type="button" onClick={() => openPersonal()}><MonitorIcon />打开个人工作区</button>
            <button type="button" onClick={() => openPersonal('new-agent')}><PlusIcon />新建个人 Agent</button>
            <button type="button" onClick={() => openPersonal('connectors')}><ConnectorIcon />连接器</button>
            <button type="button" onClick={() => openPersonal('computer')}><MonitorIcon />电脑操控</button>
            <button type="button" onClick={() => openPersonal('capabilities')}><PlugIcon />能力与工具</button>
          </div>
        )}
        administration={me.admin ? <>{error && <p className="bt-error" role="alert">{error}</p>}<Admin agents={agents.filter(agent => !agent.personal)} people={people} reload={reload} call={call} /></> : null}
        look={<div className="bt-settings-form team-appearance">
          <label>主题<select aria-label="主题" className="bt-select" value={prefs.theme} onChange={e => savePrefs({...prefs,theme:e.target.value})}>
            {Object.entries(allThemes()).map(([id,theme]) => <option key={id} value={id}>{theme.label}</option>)}
          </select></label>
          <label>消息布局<select aria-label="消息布局" className="bt-select" value={prefs.layout} onChange={e => savePrefs({...prefs,layout:e.target.value as typeof prefs.layout})}>
            <option value="bubble">气泡</option><option value="flat">平铺</option>
          </select></label>
        </div>} />}
      {modal && modal !== 'settings' && (
        <Modal
          title={
            {
              directory: '通讯录',
              new: '新建',
              create: '新建群聊',
              add: '添加成员',
              search: '搜索消息',
              settings: '设置',
            }[modal] ?? ''
          }
          close={() => setModal('')}
        >
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {modal === 'new' && hasPersonal && (
            <div className="team-workspace-links">
              <button type="button" onClick={() => openPersonal('new-agent')}><PlusIcon />新建个人 Agent</button>
              <button type="button" onClick={() => showModal('create')}><PeopleIcon />新建群聊</button>
            </div>
          )}
          {modal === 'directory' && (
            <>
              <h3>同事</h3>
              {memberOptions
                .filter((p) => p.kind === 'user')
                .map((p) => (
                  <button className="directory" key={p.id} onClick={() => newChat(p)}>
                    <Avatar id={p.id} name={p.name} />
                    {p.name}
                  </button>
                ))}
              {hasPersonal && <>
                <h3>个人 Agent</h3>
                {personalBots.map(bot => <button className="directory" key={bot.id} onClick={() => openPersonal('home', bot.id)}>
                  <Avatar id={bot.id} name={bot.name} agent />{bot.name}
                </button>)}
                <button className="directory" onClick={() => openPersonal('new-agent')}><PlusIcon />新建个人 Agent</button>
              </>}
              <h3>团队 Agent</h3>
              {memberOptions
                .filter((p) => p.kind === 'agent')
                .map((p) => (
                  <button className="directory" key={p.id} onClick={() => newChat(p)}>
                    <Avatar id={p.id} name={p.name} agent />
                    <span>
                      {p.name}
                      <small>{p.description}</small>
                    </span>
                  </button>
                ))}
            </>
          )}
          {(modal === 'create' || modal === 'add') && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const values = new FormData(e.currentTarget),
                  users = memberOptions
                    .filter((p) => p.kind === 'user' && picks.includes(p.id))
                    .map((p) => p.id),
                  agents = memberOptions
                    .filter((p) => p.kind === 'agent' && picks.includes(p.id))
                    .map((p) => p.id)
                void call(async () => {
                  for (const bot of personalBots.filter(bot => picks.includes('local:' + bot.id))) {
                    const registered = await api<{ id: string }>('/personal/agents', 'POST', bot)
                    agents.push(registered.id)
                  }
                  if (modal === 'create') {
                    const result = await api<{ id: string }>('/conversations', 'POST', {
                      kind: 'group',
                      name: values.get('name'),
                      users,
                      agents,
                    })
                    await list()
                    open(result.id)
                  } else if (roomId) {
                    await api('/conversations/' + roomId, 'PATCH', { addUsers: users, addAgents: agents })
                    await timeline(roomId)
                  }
                  setModal('')
                })
              }}
            >
              {modal === 'create' && (
                <label>
                  群名称
                  <input name="name" required maxLength={100} />
                </label>
              )}
              {memberOptions
                .filter((p) => modal === 'create' || !members.some((m) => m.id === p.id))
                .map((p) => (
                  <label className="check" key={p.id}>
                    <input
                      type="checkbox"
                      checked={picks.includes(p.id)}
                      onChange={(e) =>
                        setPicks((old) =>
                          e.target.checked ? [...old, p.id] : old.filter((id) => id !== p.id)
                        )
                      }
                    />
                    {p.kind === 'agent' ? '✦ ' : ''}
                    {p.name}
                  </label>
                ))}
              {personalBots.filter(bot => modal === 'create' || !agents.some(
                agent => agent.local_bot_id === bot.id && members.some(member => member.id === agent.id)
              )).map(bot => {
                const key = 'local:' + bot.id
                return <label className="check" key={key}>
                  <input type="checkbox" checked={picks.includes(key)} onChange={event =>
                    setPicks(old => event.target.checked ? [...old, key] : old.filter(value => value !== key))} />
                  {bot.name} · 个人 Agent
                </label>
              })}
              <button className="primary">{modal === 'create' ? '创建' : '添加'}</button>
            </form>
          )}
          {modal === 'search' && (
            <>
              <form
                className="search-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  const query = String(new FormData(e.currentTarget).get('q') ?? '')
                  void call(async () => setSearch(await api('/search?q=' + encodeURIComponent(query))))
                }}
              >
                <input aria-label="关键词" name="q" autoFocus required />
                <button className="primary">搜索</button>
              </form>
              {search?.map((m) => (
                <button
                  key={m.id}
                  className="search-result"
                  onClick={() => {
                    open(m.conversation_id)
                    setFocusMessage(m.id)
                    setModal('')
                    bottom.current = false
                    setMessages((old) => merge(old, [m]))
                  }}
                >
                  <b>
                    {rooms.find((r) => r.id === m.conversation_id)?.name} · {m.sender}
                  </b>
                  <span>{m.text || m.attachments.map((f) => f.name).join('、')}</span>
                </button>
              ))}
              {search?.length === 0 && <p>没有找到消息。</p>}
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

function App({ workspace }: { workspace?: NativeWorkspace }) {
  const { api } = useTeamApi()
  const [me, setMe] = useState<Me | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState('')
  const load = () =>
    void api<Me>('/me')
      .then(setMe, (error) => {
        if (error.status !== 401) setError(errorText(error))
      })
      .finally(() => setReady(true))
  useEffect(load, [])
  const directoryLogin = workspace && <SidebarContacts workspace={workspace}>
    <section aria-label="通讯录">
      <div className="bt-team-directory-header"><h2>通讯录</h2></div>
      {ready ? <button type="button" className="bt-row" onClick={workspace.reveal}>
        {error ? '重新连接团队' : '登录后查看同事'}
      </button> : <span className="bt-team-directory-header">正在连接团队…</span>}
    </section>
  </SidebarContacts>
  if (!ready) return <>{directoryLogin}<div className="empty">正在连接团队…</div></>
  if (error)
    return (
      <>{directoryLogin}<div className="empty">
        {error}
        <button
          onClick={() => {
            setError('')
            load()
          }}
        >
          重试
        </button>
      </div></>
    )
  if (!me || /^(#invite=|#reset=)/.test(location.hash)) return <>{directoryLogin}<Login onLogin={load} /></>
  return (
    <Chat
      key={me.id}
      me={me}
      workspace={workspace}
      logout={() => {
        setMe(null)
        desktop?.badge(0)
      }}
    />
  )
}
export function TeamApp({ origin = location.origin, workspace }: { origin?: string; workspace?: NativeWorkspace }) {
  return <TeamApiProvider origin={origin}><App workspace={workspace} /></TeamApiProvider>
}
