import { ENFORCERS } from './enforcers'
import { toHex, pad, concat, numberToHex } from 'viem'

// High-level limits -> on-chain enforcer caveats
// - maxRuns => LimitedCallsEnforcer: terms = uint256 run limit
// - dailyCapUSDC => ERC20PeriodTransferEnforcer: terms = ABI pack(token, periodSeconds, capAmount)
// - timeWindow => TimestampEnforcer: allow only if current block timestamp modulo 86400 is between start & end
//   (Simplification: encode startHour,endHour; real enforcer might expect absolute or range; adjust if spec differs)

export interface LimitConfig {
  tokenUSDC?: `0x${string}`
  dailyCapUSDC?: number
  maxRuns?: number
  timeWindow?: { startHour: number; endHour: number }
}

export function buildLimitCaveats(limits: LimitConfig, opts: { usdcToken: `0x${string}` }) {
  const caveats: { enforcer: string; terms: `0x${string}`; args: `0x${string}` }[] = []
  // LimitedCallsEnforcer
  if (limits.maxRuns && limits.maxRuns > 0) {
    const terms = pad(numberToHex(BigInt(limits.maxRuns)), { size: 32 }) as `0x${string}`
    caveats.push({ enforcer: ENFORCERS.LimitedCallsEnforcer, terms, args: '0x' })
  }
  // Daily cap via period transfer (24h) – period=86400
  if (limits.dailyCapUSDC && limits.dailyCapUSDC > 0) {
    const period = 86400n
    const cap = BigInt(Math.floor(limits.dailyCapUSDC * 1_000_000)) // 6 decimals
    // Pack: token (20) + period (8) + cap (variable 32) simple canonical concatenation padded
    const tokenPadded = pad(limits.tokenUSDC || opts.usdcToken, { size: 32 })
    const periodHex = pad(numberToHex(period), { size: 32 })
    const capHex = pad(numberToHex(cap), { size: 32 })
    const terms = (concat([tokenPadded, periodHex, capHex]) as `0x${string}`)
    caveats.push({ enforcer: ENFORCERS.ERC20PeriodTransferEnforcer, terms, args: '0x' })
  }
  // Time window using TimestampEnforcer: encode start&end hour (UTC) in first two bytes
  if (limits.timeWindow) {
    const { startHour, endHour } = limits.timeWindow
    if (startHour >=0 && startHour < 24 && endHour >=0 && endHour < 24 && startHour !== endHour) {
      const buf = new Uint8Array(32)
      buf[0] = startHour & 0xff
      buf[1] = endHour & 0xff
      const terms = ('0x' + Buffer.from(buf).toString('hex')) as `0x${string}`
      caveats.push({ enforcer: ENFORCERS.TimestampEnforcer, terms, args: '0x' })
    }
  }
  return caveats
}
