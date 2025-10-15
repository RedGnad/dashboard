#!/usr/bin/env node
import 'dotenv/config'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
}

const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http('https://testnet-rpc.monad.xyz'),
})

const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

function log(msg) {
  const timestamp = new Date().toISOString()
  const logMsg = `[${timestamp}] ${msg}`
  console.log(logMsg)
  
  // Append to monitor log
  const logFile = join(process.cwd(), 'monitor.log')
  writeFileSync(logFile, logMsg + '\n', { flag: 'a' })
}

async function checkDelegateSA() {
  try {
    const delegatePK = process.env.DELEGATE_PRIVATE_KEY
    if (!delegatePK) {
      log('❌ DELEGATE_PRIVATE_KEY missing')
      return null
    }

    const delegateEOA = privateKeyToAccount(delegatePK)
    const env = getDeleGatorEnvironment(10143)

    const delegateSA = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [delegateEOA.address, [], [], []],
      deploySalt: '0x',
      signer: { account: delegateEOA },
      environment: env,
    })

    // Check deployment
    const code = await publicClient.getBytecode({ address: delegateSA.address })
    const isDeployed = code && code !== '0x'
    
    // Check balance
    const balance = await publicClient.getBalance({ address: delegateSA.address })
    
    // Check nonce
    let nonce = null
    try {
      nonce = await publicClient.readContract({
        address: ENTRYPOINT,
        abi: [{
          type: 'function',
          name: 'getNonce',
          inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'uint192' }],
          outputs: [{ type: 'uint256' }],
          stateMutability: 'view'
        }],
        functionName: 'getNonce',
        args: [delegateSA.address, 0n]
      })
    } catch (e) {
      log(`❌ Nonce check failed: ${e.message}`)
    }

    const info = {
      eoa: delegateEOA.address,
      sa: delegateSA.address,
      deployed: isDeployed,
      balance: balance.toString(),
      balanceMON: Number(balance) / 1e18,
      nonce: nonce?.toString() || 'unknown',
      bytecodeLength: code?.length || 0
    }

    log(`✅ Delegate SA: ${info.sa}`)
    log(`   EOA: ${info.eoa}`)
    log(`   Deployed: ${info.deployed}`)
    log(`   Balance: ${info.balanceMON} MON`)
    log(`   Nonce: ${info.nonce}`)
    log(`   Bytecode: ${info.bytecodeLength} chars`)

    return info
  } catch (e) {
    log(`❌ Delegate SA check failed: ${e.message}`)
    return null
  }
}

async function checkDelegations() {
  try {
    const delegationsDir = join(process.cwd(), 'data', 'delegations')
    const files = []
    
    if (existsSync(delegationsDir)) {
      const fs = await import('fs')
      const items = fs.readdirSync(delegationsDir)
      for (const item of items) {
        if (item.endsWith('.json') && !item.includes('backup') && !item.includes('broken')) {
          files.push(item)
        }
      }
    }

    log(`📋 Active delegations: ${files.length}`)
    
    for (const file of files) {
      try {
        const filePath = join(delegationsDir, file)
        const content = readFileSync(filePath, 'utf8')
        const data = JSON.parse(content)
        
        const delegation = data.signedDelegation?.delegation
        if (delegation) {
          log(`   ${file}:`)
          log(`     Delegator: ${delegation.delegator}`)
          log(`     Delegate: ${delegation.delegate}`)
          log(`     Authority: ${delegation.authority}`)
          log(`     Caveats: ${delegation.caveats?.length || 0}`)
          
          if (delegation.delegate === '0x0000000000000000000000000000000000000a11') {
            log(`     ⚠️  INVALID DELEGATE: 0x...0a11`)
          }
        }
      } catch (e) {
        log(`   ❌ ${file}: Parse error - ${e.message}`)
      }
    }
    
    return files
  } catch (e) {
    log(`❌ Delegations check failed: ${e.message}`)
    return []
  }
}

async function checkBackendHealth() {
  try {
    const response = await fetch('http://localhost:8787/api/health')
    const data = await response.json()
    log(`✅ Backend health: ${data.ok ? 'OK' : 'FAILED'}`)
    return data.ok
  } catch (e) {
    log(`❌ Backend unreachable: ${e.message}`)
    return false
  }
}

async function fullDiagnostic() {
  log('🔍 === FULL SYSTEM DIAGNOSTIC ===')
  
  const backendOk = await checkBackendHealth()
  const delegateInfo = await checkDelegateSA()
  const delegations = await checkDelegations()
  
  log('📊 === SUMMARY ===')
  log(`Backend: ${backendOk ? '✅ OK' : '❌ DOWN'}`)
  log(`Delegate SA: ${delegateInfo ? '✅ OK' : '❌ FAILED'}`)
  log(`Delegations: ${delegations.length} active`)
  
  if (delegateInfo && !delegateInfo.deployed) {
    log('⚠️  WARNING: Delegate SA not deployed - will deploy on first UserOp')
  }
  
  if (delegations.length === 0) {
    log('⚠️  WARNING: No delegations found - create one in frontend')
  }
  
  log('='.repeat(50))
  
  return {
    backend: backendOk,
    delegate: delegateInfo,
    delegations: delegations.length
  }
}

// Monitor mode: continuous monitoring
async function startMonitoring(intervalSec = 30) {
  log('🚀 Starting continuous monitoring...')
  log(`Interval: ${intervalSec} seconds`)
  
  let lastState = null
  
  const check = async () => {
    try {
      const state = await fullDiagnostic()
      
      // Detect changes
      if (lastState) {
        if (state.delegate?.nonce !== lastState.delegate?.nonce) {
          log(`🔄 NONCE CHANGED: ${lastState.delegate?.nonce} → ${state.delegate?.nonce}`)
        }
        if (state.delegate?.deployed !== lastState.delegate?.deployed) {
          log(`🚀 DEPLOYMENT CHANGED: ${lastState.delegate?.deployed} → ${state.delegate?.deployed}`)
        }
        if (state.delegations !== lastState.delegations) {
          log(`📋 DELEGATIONS CHANGED: ${lastState.delegations} → ${state.delegations}`)
        }
      }
      
      lastState = state
    } catch (e) {
      log(`❌ Monitor error: ${e.message}`)
    }
  }
  
  // Initial check
  await check()
  
  // Periodic checks
  setInterval(check, intervalSec * 1000)
  
  log('✅ Monitoring started. Press Ctrl+C to stop.')
}

// CLI interface
const command = process.argv[2]

if (command === 'monitor') {
  const interval = parseInt(process.argv[3]) || 30
  startMonitoring(interval)
} else if (command === 'diag') {
  fullDiagnostic().then(() => process.exit(0))
} else {
  console.log('Usage:')
  console.log('  node monitor-system.js diag          # One-time diagnostic')
  console.log('  node monitor-system.js monitor [30]  # Continuous monitoring (30s interval)')
}
