import { createContext, createElement, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { prefix } from '../shared/paths.ts'

function client(origin: string) {
  const embedded = origin !== location.origin
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(origin + prefix + path, {
      method,
      credentials: 'include',
      headers: body === undefined || body instanceof FormData ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({}))
      throw Object.assign(new Error(result.error ?? '请求失败'), { status: response.status })
    }
    return response.json()
  }
  return { api, origin, embedded }
}

const context = createContext<ReturnType<typeof client> | null>(null)
export function TeamApiProvider({ origin, children }: { origin: string; children: ReactNode }) {
  const value = useMemo(() => client(origin), [origin])
  return createElement(context.Provider, { value }, children)
}
export function useTeamApi() {
  const value = useContext(context)
  if (!value) throw new Error('Team API requires its provider')
  return value
}
