#!/usr/bin/env node
import 'dotenv/config'
import { createPublicClient, http } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { writeFileSync } from 'fs'
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

const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(process.env.ZERO_DEV_BUNDLER_RPC),
})

function log(msg) {
  const timestamp = new Date().toISOString()
  const logMsg = `[${timestamp}] ${msg}`
  console.log(logMsg)
  
  // Append to UserOp log
  const logFile = join(process.cwd(), 'userop-monitor.log')
  writeFileSync(logFile, logMsg + '\n', { flag: 'a' })
}

// Intercept UserOp calls
const originalSendUserOperation = bundlerClient.sendUserOperation

bundlerClient.sendUserOperation = async function(args) {
  const sender = args.account?.address || 'unknown'
  
  log('🚀 === SENDING USEROP ===')
  log(`Sender: ${sender}`)
  log(`Calls: ${args.calls?.length || 0}`)
  log(`MaxFeePerGas: ${args.maxFeePerGas || 'auto'}`)
  log(`MaxPriorityFeePerGas: ${args.maxPriorityFeePerGas || 'auto'}`)
  log(`Nonce: ${args.nonce || 'auto'}`)
  log(`Paymaster: ${args.paymaster ? 'YES' : 'NO'}`)
  
  if (args.calls) {
    args.calls.forEach((call, i) => {
      log(`  Call ${i + 1}: ${call.to} (${call.data?.length || 0} bytes)`)
    })
  }
  
  try {
    const hash = await originalSendUserOperation.call(this, args)
    log(`✅ UserOp sent: ${hash}`)
    
    // Monitor receipt
    setTimeout(async () => {
      try {
        const receipt = await bundlerClient.waitForUserOperationReceipt({
          hash,
          timeout: 30_000
        })
        
        if (receipt.success) {
          log(`✅ UserOp confirmed: ${hash}`)
          log(`   TX: ${receipt.receipt.transactionHash}`)
          log(`   Block: ${receipt.receipt.blockNumber}`)
          log(`   Gas used: ${receipt.receipt.gasUsed}`)
        } else {
          log(`❌ UserOp failed: ${hash}`)
          log(`   Reason: ${receipt.reason || 'unknown'}`)
        }
      } catch (e) {
        log(`⏰ UserOp timeout: ${hash}`)
        log(`   Error: ${e.message}`)
      }
    }, 1000)
    
    return hash
  } catch (error) {
    log(`❌ UserOp FAILED: ${error.message}`)
    
    // Parse error details
    if (error.details) {
      log(`   Details: ${error.details}`)
    }
    
    if (error.message?.includes('AA25')) {
      log('   🔍 AA25 Error detected - analyzing...')
      if (error.message?.includes('nonce')) {
        log('     → Nonce conflict detected')
      }
      if (error.message?.includes('deployment')) {
        log('     → Deployment conflict detected')
      }
    }
    
    throw error
  }
}

log('🎯 UserOp monitor activated!')
log('All UserOps will be logged to userop-monitor.log')
log('Keep this running while testing...')

// Keep process alive
setInterval(() => {
  // Heartbeat every 60s
  log('💓 Monitor active...')
}, 60000)
