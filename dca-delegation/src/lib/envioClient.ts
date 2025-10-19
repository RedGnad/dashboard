export type GraphQLRequest = {
  query: string
  variables?: Record<string, any>
}

function pickEnvioUrl(): string {
  const primary = (import.meta as any).env?.VITE_ENVIO_GRAPHQL_URL as string | undefined
  const fast = (import.meta as any).env?.VITE_ENVIO_GRAPHQL_URL_FAST as string | undefined
  const precise = (import.meta as any).env?.VITE_ENVIO_GRAPHQL_URL_PRECISE as string | undefined
  let mode: string | undefined
  try {
    const sp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : undefined
    const fromQs = sp?.get('envio')?.toUpperCase()
    const fromLs = typeof localStorage !== 'undefined' ? localStorage.getItem('envio-endpoint')?.toUpperCase() : undefined
    mode = fromQs || fromLs
  } catch {}

  if (mode === 'PRECISE' && precise) return precise
  if (mode === 'FAST' && fast) return fast
  // fallback priority: primary -> fast -> precise
  return primary || fast || precise || ''
}

async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit & { timeoutMs?: number }, retries = 2, backoffMs = 800): Promise<Response> {
  let lastErr: any
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10000)
    try {
      const resp = await fetch(input, { ...init, signal: init.signal || ctrl.signal })
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
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, attempt)))
  }
  throw lastErr
}

export async function queryEnvio<T = any>(req: GraphQLRequest, signal?: AbortSignal): Promise<T> {
  const url = pickEnvioUrl()
  if (!url) throw new Error('Missing Envio GraphQL URL (VITE_ENVIO_GRAPHQL_URL[_FAST|_PRECISE])')

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
  return json.data as T
}
