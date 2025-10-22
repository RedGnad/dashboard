export type GraphQLRequest = {
  query: string
  variables?: Record<string, any>
}

function pickEnvioUrl(): string {
  const primary = (import.meta as any).env?.VITE_ENVIO_GRAPHQL_URL as string | undefined
  const fast = (import.meta as any).env?.VITE_ENVIO_GRAPHQL_URL_FAST as string | undefined
  const precise = (import.meta as any).env?.VITE_ENVIO_GRAPHQL_URL_PRECISE as string | undefined
  const preferred = String(((import.meta as any).env?.VITE_ENVIO_DEFAULT ?? 'AUTO')).toUpperCase()
  const forceDefault = (((import.meta as any).env?.VITE_ENVIO_FORCE_DEFAULT ?? 'false') === 'true')
  let mode: string | undefined
  try {
    if (!forceDefault) {
      const sp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : undefined
      const fromQs = sp?.get('envio')?.toUpperCase()
      const fromLs = typeof localStorage !== 'undefined' ? localStorage.getItem('envio-endpoint')?.toUpperCase() : undefined
      mode = fromQs || fromLs
    }
  } catch {}

  // If explicitly set a default preference via env, honor it unless URL param/localStorage override it
  if (!mode) {
    if (preferred === 'FAST' && fast) mode = 'FAST'
    else if (preferred === 'PRECISE' && precise) mode = 'PRECISE'
    else if (preferred === 'PRIMARY' && primary) mode = 'PRIMARY'
  }

  if (mode === 'PRECISE' && precise) return precise
  if (mode === 'FAST' && fast) return fast
  // fallback priority: primary -> fast -> precise
  return primary || fast || precise || ''
}

async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit & { timeoutMs?: number }, retries = 2, backoffMs = 800): Promise<Response> {
  let lastErr: any
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Compose external signal (if any) with an internal timeout signal
    const ctrl = new AbortController()
    const ext = init.signal as AbortSignal | undefined
    const onExternalAbort = () => {
      if (!ctrl.signal.aborted) {
        try { ctrl.abort((ext as any)?.reason ?? 'external-abort') } catch { ctrl.abort() }
      }
    }
    if (ext) {
      if (ext.aborted) {
        try { ctrl.abort((ext as any)?.reason ?? 'external-abort') } catch { ctrl.abort() }
      } else {
        ext.addEventListener('abort', onExternalAbort, { once: true })
      }
    }
    const t = setTimeout(() => {
      try { ctrl.abort('timeout') } catch { ctrl.abort() }
    }, init.timeoutMs ?? 10000)
    try {
      const resp = await fetch(input, { ...init, signal: ctrl.signal })
      clearTimeout(t)
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        lastErr = new Error(`Envio GraphQL error: ${resp.status} ${text}`)
      } else {
        return resp
      }
    } catch (e) {
      lastErr = e
    } finally {
      try { clearTimeout(t) } catch {}
      if (ext) {
        try { ext.removeEventListener('abort', onExternalAbort as any) } catch {}
      }
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, attempt)))
  }
  throw lastErr
}

export async function queryEnvio<T = any>(req: GraphQLRequest, signal?: AbortSignal): Promise<T> {
  const url = pickEnvioUrl()
  if (!url) throw new Error('Missing Envio GraphQL URL (VITE_ENVIO_GRAPHQL_URL[_FAST|_PRECISE])')

  // Request coalescing + short-lived cache to prevent bursts
  const ttlMs = Number(((import.meta as any).env?.VITE_ENVIO_REQ_TTL_MS) ?? 2000)
  const key = (() => {
    const compactQ = (req.query || '').replace(/\s+/g, ' ').trim()
    const vars = req.variables ? JSON.stringify(req.variables, Object.keys(req.variables).sort()) : ''
    return compactQ + '::' + vars
  })()

  // Simple in-memory caches
  const anyGlobal = globalThis as any
  anyGlobal.__envioCache = anyGlobal.__envioCache || new Map()
  anyGlobal.__envioInflight = anyGlobal.__envioInflight || new Map()
  const cache: Map<string, { t: number; data: any }> = anyGlobal.__envioCache
  const inflight: Map<string, Promise<any>> = anyGlobal.__envioInflight

  // Serve from cache if fresh
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && (now - cached.t) < ttlMs) {
    return cached.data as T
  }

  if (inflight.has(key)) {
    return inflight.get(key) as Promise<T>
  }

  const debugEnvio = (((import.meta as any).env?.VITE_DEBUG_ENVIO ?? 'true') === 'true')
  const sampleRate = Math.max(0, Math.min(100, Number(((import.meta as any).env?.ENVIO_LOG_SAMPLE_RATE) ?? 50))) // 0-100
  const shouldLog = debugEnvio && (Math.random() * 100 < sampleRate)
  if (shouldLog) {
    try {
      const s = (req.query || '').replace(/\s+/g, ' ').slice(0, 120)
      console.info('[envio] request', { url, q: s + (s.length === 120 ? '…' : ''), vars: Object.keys(req.variables || {}) })
    } catch {}
  }

  const p = (async () => {
    const resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
      timeoutMs: 10000,
    }, 2, 800)

    const json = await resp.json()
    if (json.errors) {
      throw new Error(`Envio GraphQL errors: ${JSON.stringify(json.errors)}`)
    }
    cache.set(key, { t: Date.now(), data: json.data })
    return json.data as T
  })()

  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key)
  }
}

// Small helper for UI/debug to display which endpoint is currently selected
export function getEnvioUrl(): string {
  return pickEnvioUrl()
}
