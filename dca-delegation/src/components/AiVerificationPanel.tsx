import { useState, useEffect } from 'react'
import { Shield, CheckCircle, AlertTriangle, XCircle, Eye, Download, Hash } from 'lucide-react'
import { useAiAudit } from '../hooks/useAiAudit'
import { useAutonomousAi } from '../hooks/useAutonomousAi'
import { useEnvioMetrics } from '../hooks/useEnvioMetrics'
import type { AuditReport } from '../lib/aiAudit'

interface AiVerificationPanelProps {
  balances: Record<string, string>
  portfolioValueMon: number
  delegationExpired: boolean
}

export default function AiVerificationPanel({ balances, portfolioValueMon, delegationExpired }: AiVerificationPanelProps) {
  const { auditHistory, isAuditing, auditDecision, getAuditStats, exportForSwarm } = useAiAudit()
  const { decisions, enabled: aiEnabled } = useAutonomousAi()
  const { metrics } = useEnvioMetrics()
  const [selectedReport, setSelectedReport] = useState<AuditReport | null>(null)
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false)

  const stats = getAuditStats()
  const latestDecision = decisions[0]

  // Auto-audit latest decision
  useEffect(() => {
    if (latestDecision && !latestDecision.executed && aiEnabled) {
      auditDecision(
        latestDecision,
        balances,
        metrics,
        portfolioValueMon,
        delegationExpired
      )
    }
  }, [latestDecision, balances, metrics, portfolioValueMon, delegationExpired, aiEnabled, auditDecision])

  const getStatusIcon = (status: 'PASS' | 'WARN' | 'FAIL') => {
    switch (status) {
      case 'PASS': return <CheckCircle className="text-green-400" size={16} />
      case 'WARN': return <AlertTriangle className="text-yellow-400" size={16} />
      case 'FAIL': return <XCircle className="text-red-400" size={16} />
    }
  }

  const getStatusColor = (status: 'PASS' | 'WARN' | 'FAIL') => {
    switch (status) {
      case 'PASS': return 'text-green-400 bg-green-600/20'
      case 'WARN': return 'text-yellow-400 bg-yellow-600/20'
      case 'FAIL': return 'text-red-400 bg-red-600/20'
    }
  }

  const generateVerificationHash = (report: AuditReport) => {
    // Simple hash for verification (in production, use proper cryptographic hash)
    const data = JSON.stringify({
      decisionId: report.decision.id,
      timestamp: report.timestamp,
      results: report.results.map(r => ({ ruleId: r.ruleId, passed: r.passed })),
      overallStatus: report.overallStatus
    })
    return btoa(data).slice(0, 16)
  }

  const exportForVerification = (report: AuditReport) => {
    const exportData = {
      ...exportForSwarm(report.decision, {
        balances,
        metrics,
        portfolioValueMon,
        delegationExpired,
        maxDailySpend: 1.0,
        maxSlippageBps: 500
      }),
      audit: {
        timestamp: report.timestamp,
        overallStatus: report.overallStatus,
        riskScore: report.riskScore,
        results: report.results,
        verificationHash: generateVerificationHash(report)
      }
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-decision-audit-${report.decision.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      {/* Status Overview */}
      <div className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xl font-semibold text-white flex items-center gap-2">
            <Shield size={18}/>AI Verification
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button 
              onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
              className="flex items-center gap-1 text-gray-300 hover:text-white"
            >
              <Eye size={14}/>{showTechnicalDetails ? 'Hide' : 'Show'} Technical
            </button>
          </div>
        </div>

        {/* Current Status */}
        {auditHistory.length > 0 && (
          <div className="grid md:grid-cols-3 gap-3 mb-4">
            <div className="glass rounded-xl p-4">
              <div className="text-sm text-gray-300">Latest Status</div>
              <div className={`flex items-center gap-2 text-lg font-semibold ${getStatusColor(auditHistory[0].overallStatus).split(' ')[0]}`}>
                {getStatusIcon(auditHistory[0].overallStatus)}
                {auditHistory[0].overallStatus}
              </div>
            </div>
            <div className="glass rounded-xl p-4">
              <div className="text-sm text-gray-300">Risk Score</div>
              <div className={`text-lg font-semibold ${auditHistory[0].riskScore > 50 ? 'text-red-400' : auditHistory[0].riskScore > 25 ? 'text-yellow-400' : 'text-green-400'}`}>
                {auditHistory[0].riskScore}/100
              </div>
            </div>
            <div className="glass rounded-xl p-4">
              <div className="text-sm text-gray-300">Success Rate</div>
              <div className="text-lg font-semibold text-white">
                {stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0}%
              </div>
            </div>
          </div>
        )}

        {/* Verification Explanation */}
        <div className="glass rounded-xl p-4 mb-4">
          <div className="text-sm text-gray-300 mb-2">🔒 Verification Garantie</div>
          <div className="text-white text-sm mb-2">
            Chaque décision IA est automatiquement vérifiée par 7 règles indépendantes :
          </div>
          <div className="grid md:grid-cols-2 gap-2 text-xs text-gray-400">
            <div>• Délégation valide</div>
            <div>• Solde suffisant</div>
            <div>• Montant raisonnable (≤5%)</div>
            <div>• Token autorisé</div>
            <div>• Activité whales acceptable</div>
            <div>• Limite journalière</div>
            <div>• Conditions de marché</div>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            ✅ PASS = Toutes vérifications OK | ⚠️ WARN = Risques mineurs | ❌ FAIL = Décision bloquée
          </div>
        </div>

        {isAuditing && (
          <div className="flex items-center gap-2 text-yellow-400 text-sm">
            <div className="animate-spin w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full"/>
            Vérification en cours...
          </div>
        )}
      </div>

      {/* Audit History */}
      {auditHistory.length > 0 && (
        <div className="glass rounded-2xl p-5">
          <div className="text-lg font-semibold text-white mb-4">Historique des Vérifications</div>
          <div className="space-y-3 max-h-60 overflow-y-auto">
            {auditHistory.slice(0, 10).map((report) => (
              <div key={report.decision.id} className="glass rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(report.overallStatus)}
                    <span className="text-sm text-gray-300">
                      {new Date(report.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`px-2 py-1 rounded text-xs ${getStatusColor(report.overallStatus)}`}>
                      {report.overallStatus}
                    </div>
                    <button 
                      onClick={() => setSelectedReport(report)}
                      className="text-gray-400 hover:text-white"
                    >
                      <Eye size={14}/>
                    </button>
                    <button 
                      onClick={() => exportForVerification(report)}
                      className="text-gray-400 hover:text-white"
                    >
                      <Download size={14}/>
                    </button>
                  </div>
                </div>
                <div className="text-white text-sm">
                  {report.decision.action.type} - Risk: {report.riskScore}/100
                </div>
                {showTechnicalDetails && (
                  <div className="mt-2 text-xs text-gray-500 flex items-center gap-2">
                    <Hash size={12}/>
                    {generateVerificationHash(report)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detailed Report Modal */}
      {selectedReport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="glass rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div className="text-xl font-semibold text-white">Rapport de Vérification</div>
              <button 
                onClick={() => setSelectedReport(null)}
                className="text-gray-400 hover:text-white"
              >
                <XCircle size={20}/>
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-gray-300">Status Global</div>
                  <div className={`flex items-center gap-2 text-lg font-semibold ${getStatusColor(selectedReport.overallStatus).split(' ')[0]}`}>
                    {getStatusIcon(selectedReport.overallStatus)}
                    {selectedReport.overallStatus}
                  </div>
                </div>
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-gray-300">Score de Risque</div>
                  <div className={`text-lg font-semibold ${selectedReport.riskScore > 50 ? 'text-red-400' : selectedReport.riskScore > 25 ? 'text-yellow-400' : 'text-green-400'}`}>
                    {selectedReport.riskScore}/100
                  </div>
                </div>
              </div>

              <div className="glass rounded-xl p-4">
                <div className="text-sm text-gray-300 mb-2">Décision IA</div>
                <div className="text-white text-sm">
                  {selectedReport.decision.action.type === 'BUY' && 
                    `Acheter ${selectedReport.decision.action.amount} ${selectedReport.decision.action.sourceToken} → ${selectedReport.decision.action.targetToken}`
                  }
                  {selectedReport.decision.action.type === 'HOLD' && 
                    `Attendre ${selectedReport.decision.action.duration}s`
                  }
                </div>
                <div className="text-gray-400 text-xs mt-1">
                  Personnalité: {selectedReport.decision.personality} | Confiance: {Math.round(selectedReport.decision.confidence * 100)}%
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm text-gray-300">Résultats des Vérifications</div>
                {selectedReport.results.map((result, index) => (
                  <div key={index} className="glass rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {result.passed ? 
                          <CheckCircle className="text-green-400" size={14} /> : 
                          <XCircle className="text-red-400" size={14} />
                        }
                        <span className="text-white text-sm font-medium">{result.ruleName}</span>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded ${
                        result.severity === 'critical' ? 'bg-red-600/20 text-red-400' :
                        result.severity === 'high' ? 'bg-orange-600/20 text-orange-400' :
                        result.severity === 'medium' ? 'bg-yellow-600/20 text-yellow-400' :
                        'bg-gray-600/20 text-gray-400'
                      }`}>
                        {result.severity}
                      </span>
                    </div>
                    <div className="text-gray-300 text-xs">{result.message}</div>
                    {result.recommendation && (
                      <div className="text-yellow-400 text-xs mt-1">💡 {result.recommendation}</div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => exportForVerification(selectedReport)}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm"
                >
                  <Download size={14}/>Exporter pour Vérification
                </button>
                <button 
                  onClick={() => setSelectedReport(null)}
                  className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm"
                >
                  Fermer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
