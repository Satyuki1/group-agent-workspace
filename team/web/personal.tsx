import { useEffect, useState } from 'react'
import type { RunInput, RunUpdate } from '../shared/protocol.ts'
import { useTeamApi } from './api.ts'

export type PersonalBot = { id: string; name: string }
type PersonalTask = { runId: string; bindingId: string; botId: string; text: string }
export type PersonalExecutor = {
  run: (task: PersonalTask) => Promise<string>
  stop: (task: PersonalTask) => Promise<unknown>
}

export function usePersonalRuns(ready: boolean, executor?: PersonalExecutor) {
  const { api } = useTeamApi()
  const [awaiting, setAwaiting] = useState<string>()
  useEffect(() => {
    if (!ready || !executor) return
    const runner = executor
    let stopped = false
    let current: RunInput | null = null
    let result: { text?: string } | null = null
    let sent = false
    let position = 0
    let started = 0
    let timer: ReturnType<typeof setTimeout>
    const task = () => ({ runId: current!.id, bindingId: current!.bindingId!,
      botId: current!.localBotId!, text: current!.prompt })
    const update = (value: RunUpdate) => api('/personal/runs/' + current!.id + '/events', 'POST', {
      lease: current!.lease, position: ++position, update: value,
    })
    function clear() {
      current = null
      result = null
      sent = false
      position = 0
      setAwaiting(undefined)
    }
    async function poll() {
      try {
        if (!current) {
          const run = await api<RunInput | null>('/personal/runs/claim', 'POST')
          if (!run || stopped) return
          current = run
          started = Date.now()
          setAwaiting(run.conversationId)
        }
        const heartbeat = await api<{ decision: string | null }>('/personal/runs/' + current.id + '/heartbeat', 'POST', { lease: current.lease })
        if (stopped) return
        if (heartbeat.decision !== 'allow') {
          if (Date.now() - started > 300000) {
            await update({ type: 'failed', reason: 'Personal Agent approval expired' })
            clear()
          }
          return
        }
        setAwaiting(undefined)
        if (!sent) {
          if (current.files.length) {
            await update({ type: 'failed', reason: 'Personal Agent group tasks currently accept text only' })
            clear()
            return
          }
          sent = true
          await update({ type: 'progress', text: '个人 Agent 正在本机执行' })
          const input = task()
          void runner.run(input).then(
            text => { if (!stopped && current?.id === input.runId) result = { text: text.slice(0, 200000) } },
            () => { if (!stopped && current?.id === input.runId) result = {} },
          )
        }
        if (result) {
          const answer = result.text
          if (answer) {
            for (let index = 0; index < answer.length; index += 8000)
              await update({ type: 'delta', text: answer.slice(index, index + 8000) })
            await update({ type: 'complete' })
          } else await update({ type: 'failed', reason: 'Personal Agent did not return a reply' })
          clear()
        } else if (Date.now() - started > 600000) {
          void runner.stop(task())
          await update({ type: 'failed', reason: 'Personal Agent timed out' })
          clear()
        }
      } catch {
        if (sent) void runner.stop(task())
        if (!stopped) clear()
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 1600)
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
        if (sent) void runner.stop(task())
    }
  }, [api, ready, executor])

  return awaiting
}
