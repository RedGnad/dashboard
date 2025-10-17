export type GraphQLRequest = {
  query: string
  variables?: Record<string, any>
}

export async function queryEnvio<T = any>(req: GraphQLRequest, signal?: AbortSignal): Promise<T> {
  const url = import.meta.env.VITE_ENVIO_GRAPHQL_URL as string | undefined
  if (!url) throw new Error('Missing VITE_ENVIO_GRAPHQL_URL')

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Envio GraphQL error: ${resp.status} ${text}`)
  }
  const json = await resp.json()
  if (json.errors) {
    throw new Error(`Envio GraphQL errors: ${JSON.stringify(json.errors)}`)
  }
  return json.data as T
}
