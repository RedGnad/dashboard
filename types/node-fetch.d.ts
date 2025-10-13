// Minimal ambient module declaration to satisfy TS for dynamic import in scheduler.
// We only need the default export typing used (function returning a promise-like Response with ok/status/headers.get).
// For full types, install @types/node-fetch, but this lightweight stub avoids extra dependency now.

declare module 'node-fetch' {
  interface FetchHeaders { get(name: string): string | null }
  interface FetchResponse { ok: boolean; status: number; headers: FetchHeaders }
  const fetchFn: (url: string, init?: any) => Promise<FetchResponse>
  export default fetchFn
}
