import React, { useEffect, useState } from 'react'
import { HeaderPill } from '../../ds-bot/src/client/header.js'
import { BrandMark, BrandName, TeamSidebar, YouAvatar } from '../../ds-bot/src/client/sidebar.js'
import { SettingsDialog } from '../../ds-bot/src/client/settings.js'
import { Bubbles } from '../../ds-bot/src/client/cells.js'
import { BotMark } from '../../ds-bot/src/client/mark.js'
import { GearIcon, MonitorIcon, PeopleIcon } from '../../ds-bot/src/client/icons.js'
import { allThemes, themeCss, widthOf, flatWidthOf } from '../../ds-bot/src/client/themes.js'
import { MarkdownText } from '../../ds-bot/src/client/dsh-primitives.js'

const blank = {}
const selectBlank = select => select(blank)
const noop = () => {}
const person = (entry, agent = false) => ({
  id: entry.id,
  name: entry.name,
  ...(agent ? {} : { color: 'gray', avatar: { shape: 'gumdrop' } }),
})

export function useBotAppearance(prefs, enabled) {
  useEffect(() => {
    if (!enabled) return
    const theme = allThemes()[prefs.theme] ?? allThemes().deepseek
    const sheet = document.createElement('style')
    sheet.textContent = themeCss(theme, prefs.accent)
    document.head.append(sheet)
    document.body.dataset.btLayout = prefs.layout ?? 'bubble'
    document.body.style.setProperty('--bt-msg-w', String(widthOf(prefs) / 100))
    document.body.style.setProperty('--bt-flat-w', String(flatWidthOf(prefs) / 100))
    return () => sheet.remove()
  }, [prefs, enabled])
}

export function Brand() {
  return <div className="bt-brand team-brand"><BrandMark /><BrandName /></div>
}

export function Avatar({ name, id = name, agent = false, size = 36 }) {
  return <BotMark bot={person({ id: id ?? name, name }, agent)} size={size} />
}

export function NativeChrome({ rooms, active, people, agents, members, runs, prefs, panel, open, showPanel, showModal, personalUrl, embedded }) {
  const [viewport, setViewport] = useState(window.innerWidth)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [pref, setSidebarPref] = useState('open')
  const [drawer, setLeftDrawer] = useState(false)
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const byId = Object.fromEntries([
    ...people.map(entry => [entry.id, person(entry)]),
    ...agents.map(entry => [entry.id, person(entry, true)]),
  ])
  const groupRows = rooms.map(room => {
    const loaded = room.id === active?.id && members.length
    const fallbackId = room.kind === 'agent'
      ? agents.find(agent => agent.name === room.name)?.id
      : room.kind === 'dm' ? people.find(entry => entry.name === room.name)?.id : undefined
    return {
      ...room, sessionId: room.id, createdAt: Date.parse(room.updated_at),
      members: loaded ? members.map(entry => entry.id) : fallbackId ? [fallbackId] : [],
    }
  })
  const roster = {
    ready: true, prefs, bots: [], byId,
    rooms: groupRows, roomsById: Object.fromEntries(groupRows.map(room => [room.id, room])),
    agents: [], sections: [], memory: false,
  }
  const sessions = {
    ids: rooms.map(room => room.id),
    byId: Object.fromEntries(rooms.map(room => [room.id, {
      id: room.id, title: room.name, retainedBy: { mainView: Number(room.id === active?.id) },
      updatedAt: Date.parse(room.updated_at),
    }])),
  }
  const status = new Map(rooms.map(room => [room.id, {
    completionUnread: room.unread > 0,
    running: room.id === active?.id && runs.some(run => ['running', 'approval'].includes(run.status)),
  }]))
  const ui = { unread: {}, leftDrawer: drawer, details: panel ? active?.id : null, panelYield: true }
  const actions = {
    openSession: open,
    openMenu: room => { open(room.id); showPanel(true) },
    openPalette: () => showModal('search'),
    openNewChat: () => showModal(personalUrl ? 'new' : 'create'),
    setSidebarWidth, setSidebarPref, setLeftDrawer,
    toggleLeftHidden: () => {
      if (pref === 'hidden') setSidebarPref('open')
      else if (viewport < sidebarWidth + 420) {
        setSidebarPref('open')
        setLeftDrawer(value => !value)
      } else setSidebarPref('hidden')
    },
    toggleDetails: () => showPanel(!panel),
    beginVisit: noop, endVisit: noop, clearUnread: noop, clearLive: noop,
    setFlags: async () => {},
  }
  const views = {
    actions, useRoster: select => select(roster), useSessions: select => select(sessions),
    useUi: select => select(ui), useSessionStatus: select => select(status),
    useSessionRetainInfo: (id, select) => select(sessions.byId[id]),
    useActivity: selectBlank, useUpdate: selectBlank, useRegistry: selectBlank, useTurnClock: selectBlank,
    useLive: selectBlank, useSession: selectBlank,
    useFrame: select => select({ viewport, sidebarWidth, collapsedWidth: 0 }),
    useSidebarPref: select => select(pref),
  }
  return <>
    {!embedded && <TeamSidebar {...views} wide teamControls={{
      directory: <button type="button" className="bt-round" aria-label="通讯录" title="通讯录" onClick={() => showModal('directory')}><PeopleIcon /></button>,
      account: <button type="button" className="dsb-settings" aria-label="设置" title="设置" onClick={() => showModal('settings')}><YouAvatar /></button>,
    }} />}
    {active && <div className="dsb-head">
      <HeaderPill {...views} sessionId={active.id} />
    </div>}
  </>
}

export function NativeSettings({ page, setPage, close, profile, administration, look, personal }) {
  const pages = [
    { id: 'team-profile', label: '账户', icon: PeopleIcon, content: profile },
    { id: 'team-appearance', label: 'Appearance', icon: GearIcon, content: look },
    ...(personal ? [{ id: 'team-personal', label: '个人工作区', icon: MonitorIcon, content: personal }] : []),
    ...(administration ? [{ id: 'team-administration', label: '团队管理', icon: GearIcon, content: administration }] : []),
  ]
  return <SettingsDialog page={page} roster={{}} customPages={pages}
    actions={{ openSettings: setPage, closeSettings: close }} useUpdate={selectBlank} />
}

export function NativeMessage({ message, mine, children }) {
  const id = message.agent_id ?? message.user_id
  const sender = person({ id, name: message.sender }, Boolean(message.agent_id))
  const roster = { prefs: {}, bots: [], byId: { [id]: sender } }
  if (mine) return <div className="bt-urow team-urow">
    <div className="bt-ububble">
      {message.text && <MarkdownText text={message.text} variant="compact" />}
      {children}
    </div>
  </div>
  return <div className="bt-group-msg team-group-msg">
    <div className="bt-group-name">
      <span className="bt-lead"><Avatar id={id} name={sender.name} agent={Boolean(message.agent_id)} size={22} /></span>
      {sender.name}
      {message.agent_id && <span className="bt-group-role">Agent</span>}
      <time className="bt-group-time">{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    {message.text && <Bubbles texts={[message.text]} roster={roster} selfId={id}
      actions={{ openSession: noop }} streaming={message.status === 'running'} />}
    {children}
  </div>
}
