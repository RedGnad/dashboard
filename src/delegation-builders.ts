// DEPRECATED PLACEHOLDER FILE
// Conservé uniquement pour rétro-compatibilité de vieux JSON qui auraient été générés
// avec les pseudo enforcers TIME_WINDOW_ENFORCER / DAILY_CAP_ENFORCER.
// Ne plus utiliser pour de nouvelles délégations: utiliser `caveat-builders.ts` (officiels).

import { Address } from 'viem'

// Adresses d'enforcers (placeholder) – à configurer via env quand déployés
const TIME_WINDOW_ENFORCER = (process.env.TIME_WINDOW_ENFORCER || '0x0000000000000000000000000000000000000001').toLowerCase()
const DAILY_CAP_ENFORCER   = (process.env.DAILY_CAP_ENFORCER   || '0x0000000000000000000000000000000000000002').toLowerCase()

export type TimeWindowConfig = { startHour: number; endHour: number } // heures UTC [0,24)
export type DailyCapConfig = { capUSDC: number } // cap en USDC entiers

export interface CaveatLike { enforcer: Address; terms: `0x${string}`; args?: any[] }

// Encodage minimaliste (phase 1, pourra être remplacé par ABI officielle des enforcers):
// timeWindow terms (bytes32): [ startHour (1) | endHour (1) | reserved zero padding (30) ] => permet lecture ultra simple côté off-chain.
// dailyCap terms (uint256)   : valeur en micro-USDC (cap * 1e6) pour cohérence avec tokénomics USDC (6 décimales).
// IMPORTANT: Les adresses d'enforcer actuelles sont des placeholders; à remplacer après déploiement réel.

function encodeTimeWindow(cfg: TimeWindowConfig): `0x${string}` {
  const buf = new Uint8Array(32)
  buf[0] = cfg.startHour & 0xff
  buf[1] = cfg.endHour & 0xff
  return '0x' + Buffer.from(buf).toString('hex') as `0x${string}`
}

function encodeDailyCap(cfg: DailyCapConfig): `0x${string}` {
  const micro = BigInt(Math.floor(cfg.capUSDC * 1_000_000))
  const hex = micro.toString(16).padStart(64, '0')
  return ('0x' + hex) as `0x${string}`
}

export function buildCaveats(options: { timeWindow?: TimeWindowConfig; dailyCap?: DailyCapConfig; existing?: CaveatLike[] }): CaveatLike[] {
  const out: CaveatLike[] = [...(options.existing || [])]
  if (options.timeWindow) {
    // remove old
    for (let i = out.length - 1; i >= 0; i--) if (out[i].enforcer.toLowerCase() === TIME_WINDOW_ENFORCER) out.splice(i, 1)
    out.push({ enforcer: TIME_WINDOW_ENFORCER as Address, terms: encodeTimeWindow(options.timeWindow) })
  }
  if (options.dailyCap) {
    for (let i = out.length - 1; i >= 0; i--) if (out[i].enforcer.toLowerCase() === DAILY_CAP_ENFORCER) out.splice(i, 1)
    out.push({ enforcer: DAILY_CAP_ENFORCER as Address, terms: encodeDailyCap(options.dailyCap) })
  }
  return out
}

export function decodeCaveats(caveats: CaveatLike[]) {
  const res: { timeWindow?: TimeWindowConfig; dailyCap?: DailyCapConfig } = {}
  for (const c of caveats) {
    const enf = c.enforcer.toLowerCase()
    if (enf === TIME_WINDOW_ENFORCER) {
      const bytes = Buffer.from(c.terms.slice(2), 'hex')
      const startHour = bytes[0]
      const endHour = bytes[1]
      res.timeWindow = { startHour, endHour }
    } else if (enf === DAILY_CAP_ENFORCER) {
      try {
        const cap = BigInt(c.terms)
        res.dailyCap = { capUSDC: Number(cap / 1_000_000n) }
      } catch {}
    }
  }
  return res
}

export function mergeDelegationCaveats(base: any, opts: { timeWindow?: TimeWindowConfig; dailyCap?: DailyCapConfig }) {
  // Deprecated path: return existing unchanged to avoid mutating signed data.
  return (base?.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args }))
}
