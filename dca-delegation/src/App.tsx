import { useState } from 'react'
import { useAccount, useSignMessage, useChainId, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import Background from './components/Background'
import ParticlesLayer from './components/ParticlesLayer'
import WhaleNotifications from './components/WhaleNotifications'
import DcaControl from './components/DcaControl'
import ModelStage from './components/ModelStage'
import AiBubbleOverlay from './components/AiBubbleOverlay'
import { CHAIN_ID } from './lib/chain'
import { useAutonomousAi } from './hooks/useAutonomousAi'

function App() {
  const { address, isConnected } = useAccount()
  const { signMessage } = useSignMessage()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const { personality } = useAutonomousAi()

  const modelUrl = (() => {
    const map: Record<string, string> = {
      conservative: '/models/conservative.glb',
      balanced: '/models/balanced.glb',
      aggressive: '/models/aggressive.glb',
      contrarian: '/models/contrarian.glb',
    }
    return map[personality] || '/model.glb'
  })()

  const handlePersonalSign = async () => {
    if (!address) return

    setIsAuthenticating(true)
    try {
      const message = `Welcome to DCA Delegation!\n\nSign this message to access the application.\n\nAddress: ${address}\nTimestamp: ${Date.now()}`
      
      await signMessage(
        { message },
        {
          onSuccess: () => {
            setIsAuthenticated(true)
            setIsAuthenticating(false)
          },
          onError: (error) => {
            console.error('Sign message failed:', error)
            setIsAuthenticating(false)
          }
        }
      )
    } catch (error) {
      console.error('Personal sign failed:', error)
      setIsAuthenticating(false)
    }
  }


  return (
    <div className="min-h-screen relative">
      <Background />
      <ParticlesLayer />
      {isConnected && isAuthenticated && <WhaleNotifications />}
      {isAuthenticated && <ModelStage modelUrl={modelUrl} />}
      {isAuthenticated && <AiBubbleOverlay />}
      
      <div className="relative z-10 min-h-screen flex items-center justify-center p-4">
        {!isConnected ? (
          <div className="glass rounded-2xl p-8 max-w-md w-full text-center">
            <h1 className="text-3xl font-bold mb-6 bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
              DCA Delegation
            </h1>
            <p className="text-gray-300 mb-8">
              Connect your wallet to start using DCA with delegation on Monad Testnet
            </p>
            <ConnectKitButton.Custom>
              {({ isConnected, show, truncatedAddress, ensName }) => {
                return (
                  <button
                    onClick={show}
                    className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-semibold py-3 px-6 rounded-xl transition-all duration-200 transform hover:scale-105"
                  >
                    {isConnected ? ensName ?? truncatedAddress : "Connect Wallet"}
                  </button>
                )
              }}
            </ConnectKitButton.Custom>
          </div>
        ) : chainId !== CHAIN_ID ? (
          <div className="glass rounded-2xl p-8 max-w-md w-full text-center">
            <h2 className="text-2xl font-bold mb-4 text-white">Wrong Network</h2>
            <p className="text-gray-300 mb-6">
              Please switch to Monad Testnet (Chain ID: {CHAIN_ID}) to continue.
            </p>
            <button
              onClick={() => switchChain({ chainId: CHAIN_ID })}
              className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white font-semibold py-3 px-6 rounded-xl transition-all duration-200 transform hover:scale-105"
            >
              Switch to Monad Testnet
            </button>
          </div>
        ) : !isAuthenticated ? (
          <div className="glass rounded-2xl p-8 max-w-md w-full text-center">
            <h2 className="text-2xl font-bold mb-4 text-white">
              Authentication Required
            </h2>
            <p className="text-gray-300 mb-6">
              Please sign a message to verify your identity and access the application.
            </p>
            <p className="text-sm text-gray-400 mb-8">
              Connected: {address?.slice(0, 6)}...{address?.slice(-4)}
            </p>
            <button
              onClick={handlePersonalSign}
              disabled={isAuthenticating}
              className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-xl transition-all duration-200 transform hover:scale-105"
            >
              {isAuthenticating ? 'Signing...' : 'Sign Message'}
            </button>
          </div>
        ) : (
          <DcaControl />
        )}
      </div>
      
    </div>
  )
}

export default App
