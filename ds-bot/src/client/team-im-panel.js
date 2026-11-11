import { createElement as h, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { frameLayout } from './frame-layout.js'
import { TeamApp } from '../../../team/web/app.tsx'
import panelStyles from './team-im-panel.css'
import teamStyles from '../../../team/web/style.css'
import conversationStyles from '../../../app/ui/src/app.css'
import { call } from './api.js'
import { t } from './i18n.js'
import { installCompiledStyles } from './styles.js'

const executor = {
  run: task => call('team-im-run', task),
  stop: task => call('team-im-stop', task).catch(() => {}),
}

function TeamImPanel({ origin, open, left, roster, target, command, actions }) {
  useEffect(() => installCompiledStyles(
    `@scope (.dsb-team-pane) { ${conversationStyles} ${teamStyles} }` + panelStyles, 'team-im',
  ), [])
  const workspace = {
    bots: roster.bots.filter(bot => !bot.private && !bot.hidden).map(({ id, name }) => ({ id, name })),
    execute: executor,
    target,
    visible: open,
    command,
    reveal: actions.openTeamWorkspace,
    consumeCommand: actions.consumeTeamDirectoryCommand,
    open(page, botId) {
      actions.closeTeamWorkspace()
      if (page === 'new-agent') actions.openNewChat('create')
      else if (['connectors', 'computer', 'capabilities'].includes(page)) actions.openSettings(page)
      else if (botId) actions.openSession(botId)
    },
  }
  return h('section', { className: 'dsb-team-pane', hidden: !open, style: { left }, 'aria-label': t('Team messages') },
    h('div', { className: 'dsb-team-content' }, h(TeamApp, { origin, workspace })))
}

export function TeamImOverlay({ useUi, useRoster, useFrame, useSidebarPref, actions }) {
  const origin = useUi(ui => ui.teamImOrigin)
  const open = useUi(ui => ui.teamImOpen === true)
  const drawer = useUi(ui => ui.leftDrawer === true)
  const target = useUi(ui => ui.teamDirectoryTarget)
  const command = useUi(ui => ui.teamDirectoryCommand)
  const roster = useRoster(value => value)
  const frame = useFrame(value => value)
  const pref = useSidebarPref(value => value)
  if (!origin) return null
  const { column } = frameLayout({ viewport: frame.viewport, sidebarWidth: frame.sidebarWidth, pref, drawer })
  return createPortal(h(TeamImPanel, { origin, open, left: column, roster, target, command, actions }), document.body)
}
