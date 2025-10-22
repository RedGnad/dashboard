import { useState, useEffect } from "react";
import {
  Shield,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Eye,
  Download,
} from "lucide-react";
import { useAiAudit } from "../hooks/useAiAudit";
import { useAutonomousAi } from "../hooks/useAutonomousAi";
import { useEnvioMetrics } from "../hooks/useEnvioMetrics";
import { getEnvioUrl } from "../lib/envioClient";
import type { AuditReport } from "../lib/aiAudit";

interface AiVerificationPanelProps {
  balances: Record<string, string>;
  portfolioValueMon: number;
  delegationExpired: boolean;
}

export default function AiVerificationPanel({
  balances,
  portfolioValueMon,
  delegationExpired,
}: AiVerificationPanelProps) {
  const { auditHistory, isAuditing, auditDecision, exportForSwarm } =
    useAiAudit();
  const { decisions, enabled: aiEnabled } = useAutonomousAi();
  const { metrics, loading: envioLoading } = useEnvioMetrics();
  const [selectedReport, setSelectedReport] = useState<AuditReport | null>(
    null
  );
  // Removed technical hash preview (not useful for users)

  const latestDecision = decisions[0];

  // Auto-audit latest decision; re-audit if fresher metrics arrive
  useEffect(() => {
    // Trigger immediately on first decision (even if metrics are still loading);
    // will automatically re-audit once metrics.lastUpdated advances.
    if (!latestDecision || !aiEnabled) return;

    const latestForDecision = auditHistory.find(
      (r) => r.decision.id === latestDecision.id
    );
    const needAudit =
      !latestForDecision ||
      (metrics?.lastUpdated &&
        latestForDecision.timestamp < metrics.lastUpdated - 500);
    if (!needAudit) return;

    const debugEnvio =
      ((import.meta as any).env?.VITE_DEBUG_ENVIO ?? "true") === "true";
    const endpoint = getEnvioUrl();
    if (debugEnvio) {
      console.info("[ai] pre-audit", {
        decisionId: latestDecision.id,
        endpoint,
        envioLoading,
        txToday: metrics?.txToday,
        whales: metrics?.whales24h?.length,
        feesTodayMon: metrics?.feesTodayMon,
        lastUpdatedISO: metrics?.lastUpdated
          ? new Date(metrics.lastUpdated).toISOString()
          : null,
      });
    }

    (async () => {
      const report = await auditDecision(
        latestDecision,
        balances,
        metrics,
        portfolioValueMon,
        delegationExpired
      );
      if (debugEnvio) {
        console.info("[ai] post-audit", {
          decisionId: latestDecision.id,
          overallStatus: report.overallStatus,
          riskScore: report.riskScore,
          marketRule: report.results.find(
            (r) => r.ruleId === "market-conditions"
          )?.message,
        });
      }
    })();
  }, [
    latestDecision,
    auditHistory,
    balances,
    metrics,
    portfolioValueMon,
    delegationExpired,
    aiEnabled,
    envioLoading,
    auditDecision,
  ]);

  const getStatusIcon = (status: "PASS" | "WARN" | "FAIL") => {
    switch (status) {
      case "PASS":
        return <CheckCircle className="text-green-400" size={16} />;
      case "WARN":
        return <AlertTriangle className="text-yellow-400" size={16} />;
      case "FAIL":
        return <XCircle className="text-red-400" size={16} />;
    }
  };

  const getStatusColor = (status: "PASS" | "WARN" | "FAIL") => {
    switch (status) {
      case "PASS":
        return "text-green-400 bg-green-600/20";
      case "WARN":
        return "text-yellow-400 bg-yellow-600/20";
      case "FAIL":
        return "text-red-400 bg-red-600/20";
    }
  };

  // Technical hash preview removed

  // Glow state for the whole panel
  const latestTsGlow = auditHistory[0]?.timestamp || 0;
  const metricsTsGlow = metrics?.lastUpdated || 0;
  const needsRefresh =
    auditHistory.length > 0 && metricsTsGlow > latestTsGlow + 500;
  const latestStatus = auditHistory[0]?.overallStatus as
    | "PASS"
    | "WARN"
    | "FAIL"
    | undefined;
  const panelGlowClass = (() => {
    // Yellow only when auditing or when metrics are fresher (refresh pending)
    if (isAuditing || needsRefresh) {
      return "ring-1 ring-yellow-400/40 shadow-[0_0_28px_rgba(250,204,21,0.35)] animate-pulse";
    }
    // Red if latest audit failed
    if (latestStatus === "FAIL") {
      return "ring-1 ring-red-400/40 shadow-[0_0_28px_rgba(248,113,113,0.25)]";
    }
    // If latest audit exists but had 0 tx at audit time, show yellow (non-pulsing)
    if (auditHistory.length > 0) {
      const txAtAudit = auditHistory[0].txTodayAtAudit ?? 0;
      if (txAtAudit <= 0) {
        return "ring-1 ring-yellow-400/40 shadow-[0_0_20px_rgba(250,204,21,0.20)]";
      }
      // Otherwise green when up-to-date with some activity
      return "ring-1 ring-emerald-400/40 shadow-[0_0_28px_rgba(52,211,153,0.25)]";
    }
    // Neutral otherwise
    return "";
  })();

  return (
    <div className={`space-y-4 transition-shadow ${panelGlowClass}`}>
      {/* Status Overview */}
      <div className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xl font-semibold text-white flex items-center gap-2">
            <Shield size={18} />
            AI Verification
          </div>
          <div className="flex items-center gap-3 text-sm">
            {/* Live audit indicator (process state, not risk level) */}
            {(() => {
              const hasAudit = auditHistory.length > 0;
              if (isAuditing) {
                return (
                  <div className="flex items-center gap-2 px-2 py-1 rounded border shadow-[0_0_12px_rgba(250,204,21,0.45)] bg-yellow-500/10 border-yellow-400/30 text-yellow-300">
                    <div className="w-2 h-2 rounded-full bg-yellow-300 animate-pulse" />
                    <span>Auditing…</span>
                  </div>
                );
              }
              if (hasAudit && needsRefresh) {
                return (
                  <div className="flex items-center gap-2 px-2 py-1 rounded border shadow-[0_0_12px_rgba(250,204,21,0.35)] bg-yellow-500/10 border-yellow-400/30 text-yellow-300">
                    <div className="w-2 h-2 rounded-full bg-yellow-300" />
                    <span>Refreshing…</span>
                  </div>
                );
              }
              if (hasAudit) {
                const txAtAudit = auditHistory[0].txTodayAtAudit ?? 0;
                if (txAtAudit <= 0) {
                  return (
                    <div className="flex items-center gap-2 px-2 py-1 rounded border shadow-[0_0_12px_rgba(250,204,21,0.25)] bg-yellow-500/10 border-yellow-400/30 text-yellow-300">
                      <div className="w-2 h-2 rounded-full bg-yellow-300" />
                      <span>Awaiting activity…</span>
                    </div>
                  );
                } else {
                  return (
                    <div className="flex items-center gap-2 px-2 py-1 rounded border shadow-[0_0_14px_rgba(74,222,128,0.45)] bg-emerald-500/10 border-emerald-400/30 text-emerald-300">
                      <div className="w-2 h-2 rounded-full bg-emerald-300" />
                      <span>Audit up to date</span>
                    </div>
                  );
                }
              }
              if (latestDecision && aiEnabled) {
                return (
                  <div className="flex items-center gap-2 px-2 py-1 rounded border shadow-[0_0_12px_rgba(250,204,21,0.35)] bg-yellow-500/10 border-yellow-400/30 text-yellow-300">
                    <div className="w-2 h-2 rounded-full bg-yellow-300" />
                    <span>Awaiting first audit…</span>
                  </div>
                );
              }
              return (
                <div className="flex items-center gap-2 px-2 py-1 rounded border bg-white/5 border-white/10 text-gray-300">
                  <div className="w-2 h-2 rounded-full bg-gray-300" />
                  <span>Idle</span>
                </div>
              );
            })()}
            {/* Technical toggle removed */}
            <button
              onClick={() =>
                latestDecision &&
                auditDecision(
                  latestDecision,
                  balances,
                  metrics,
                  portfolioValueMon,
                  delegationExpired
                )
              }
              disabled={!latestDecision || isAuditing}
              className={`px-2 py-1 rounded ${
                isAuditing
                  ? "bg-white/5 text-gray-400"
                  : "bg-white/10 text-gray-200 hover:text-white"
              }`}
              title={
                !latestDecision
                  ? "No decision to audit"
                  : "Run verification on latest decision"
              }
            >
              Audit latest decision
            </button>
          </div>
        </div>

        {/* Live audit status (compact) */}
        {auditHistory.length > 0 && (
          <div className="grid md:grid-cols-3 gap-2 mb-3">
            <div className="glass rounded-xl p-3">
              <div className="text-sm text-gray-300">Latest Status</div>
              <div
                className={`flex items-center gap-2 text-base font-semibold ${
                  getStatusColor(auditHistory[0].overallStatus).split(" ")[0]
                }`}
              >
                {getStatusIcon(auditHistory[0].overallStatus)}
                {auditHistory[0].overallStatus}
              </div>
            </div>
            <div className="glass rounded-xl p-3">
              <div className="text-sm text-gray-300">Risk Score</div>
              <div
                className={`text-base font-semibold ${
                  auditHistory[0].riskScore > 50
                    ? "text-red-400"
                    : auditHistory[0].riskScore > 25
                    ? "text-yellow-400"
                    : "text-green-400"
                }`}
              >
                {auditHistory[0].riskScore}/100
              </div>
            </div>
            {/* Success Rate removed to reduce clutter and confusion */}
          </div>
        )}

        {/* Success Rate removed */}

        {/* Verification Explanation */}
        <div className="glass rounded-xl p-4 mb-4">
          <div className="text-sm text-gray-300 mb-2">
            🔒 Verification Guarantee
          </div>
          <div className="text-white text-sm mb-2">
            Each AI decision is automatically verified by 7 independent rules:
          </div>
          <div className="grid md:grid-cols-2 gap-2 text-xs text-gray-400">
            <div>• Valid delegation</div>
            <div>• Sufficient balance</div>
            <div>• Reasonable amount (≤5%)</div>
            <div>• Allowed token</div>
            <div>• Acceptable whale activity</div>
            <div>• Daily limit</div>
            <div>• Market conditions</div>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            ✅ PASS = All checks OK | ⚠️ WARN = Minor risks | ❌ FAIL = Decision
            blocked
          </div>
        </div>

        {isAuditing && (
          <div className="flex items-center gap-2 text-yellow-400 text-sm">
            <div className="animate-spin w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full" />
            Verification in progress...
          </div>
        )}
      </div>

      {/* Audit History */}
      {auditHistory.length > 0 && (
        <div className="glass rounded-2xl p-5">
          <div className="text-lg font-semibold text-white mb-4">
            Verification History
          </div>
          <div className="space-y-3 max-h-60 overflow-y-auto">
            {auditHistory.slice(0, 10).map((report) => (
              // Use decisionId+timestamp for uniqueness: the same decision can be re-audited with fresher metrics
              <div
                key={`${report.decision.id}-${report.timestamp}`}
                className="glass rounded-lg p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(report.overallStatus)}
                    {/* Activity badge: yellow when 0 tx, green when >0 tx at audit time */}
                    {(() => {
                      const txAtAudit = report.txTodayAtAudit ?? 0;
                      const color =
                        txAtAudit > 0 ? "bg-emerald-400" : "bg-yellow-300";
                      const title = `Activity: ${txAtAudit} tx`;
                      return (
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${color}`}
                          title={title}
                        />
                      );
                    })()}
                    <span className="text-sm text-gray-300">
                      {new Date(report.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className={`px-2 py-1 rounded text-xs ${getStatusColor(
                        report.overallStatus
                      )}`}
                    >
                      {report.overallStatus}
                    </div>
                    <button
                      onClick={() => setSelectedReport(report)}
                      className="text-gray-400 hover:text-white"
                    >
                      <Eye size={14} />
                    </button>
                    <button
                      onClick={() =>
                        exportForSwarm(report.decision, {
                          balances,
                          metrics,
                          portfolioValueMon,
                          delegationExpired,
                          maxDailySpend: 1.0,
                          maxSlippageBps: 500,
                        })
                      }
                      className="text-gray-400 hover:text-white"
                    >
                      <Download size={14} />
                    </button>
                  </div>
                </div>
                <div className="text-white text-sm">
                  {report.decision.action.type} - Risk: {report.riskScore}/100
                </div>
                {/* Technical hash removed */}
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
              <div className="text-xl font-semibold text-white">
                Verification Report
              </div>
              <button
                onClick={() => setSelectedReport(null)}
                className="text-gray-400 hover:text-white"
              >
                <XCircle size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-gray-300">Overall Status</div>
                  <div
                    className={`flex items-center gap-2 text-lg font-semibold ${
                      getStatusColor(selectedReport.overallStatus).split(" ")[0]
                    }`}
                  >
                    {getStatusIcon(selectedReport.overallStatus)}
                    {selectedReport.overallStatus}
                  </div>
                </div>
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-gray-300">Risk Score</div>
                  <div
                    className={`text-lg font-semibold ${
                      selectedReport.riskScore > 50
                        ? "text-red-400"
                        : selectedReport.riskScore > 25
                        ? "text-yellow-400"
                        : "text-green-400"
                    }`}
                  >
                    {selectedReport.riskScore}/100
                  </div>
                </div>
              </div>

              <div className="glass rounded-xl p-4">
                <div className="text-sm text-gray-300 mb-2">AI Decision</div>
                <div className="text-white text-sm">
                  {selectedReport.decision.action.type === "BUY" &&
                    `Buy ${selectedReport.decision.action.amount} ${selectedReport.decision.action.sourceToken} → ${selectedReport.decision.action.targetToken}`}
                  {selectedReport.decision.action.type === "HOLD" &&
                    `Hold ${selectedReport.decision.action.duration}s`}
                </div>
                <div className="text-gray-400 text-xs mt-1">
                  Personality: {selectedReport.decision.personality} |
                  Confidence:{" "}
                  {Math.round(selectedReport.decision.confidence * 100)}%
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm text-gray-300">
                  Verification Results
                </div>
                {selectedReport.results.map((result, index) => (
                  <div key={index} className="glass rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {result.passed ? (
                          <CheckCircle className="text-green-400" size={14} />
                        ) : (
                          <XCircle className="text-red-400" size={14} />
                        )}
                        <span className="text-white text-sm font-medium">
                          {result.ruleName}
                        </span>
                      </div>
                      <span
                        className={`text-xs px-2 py-1 rounded ${
                          result.severity === "critical"
                            ? "bg-red-600/20 text-red-400"
                            : result.severity === "high"
                            ? "bg-orange-600/20 text-orange-400"
                            : result.severity === "medium"
                            ? "bg-yellow-600/20 text-yellow-400"
                            : "bg-gray-600/20 text-gray-400"
                        }`}
                      >
                        {result.severity}
                      </span>
                    </div>
                    <div className="text-gray-300 text-xs">
                      {result.message}
                    </div>
                    {result.recommendation && (
                      <div className="text-yellow-400 text-xs mt-1">
                        💡 {result.recommendation}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() =>
                    exportForSwarm(selectedReport.decision, {
                      balances,
                      metrics,
                      portfolioValueMon,
                      delegationExpired,
                      maxDailySpend: 1.0,
                      maxSlippageBps: 500,
                    })
                  }
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm"
                >
                  <Download size={14} />
                  Export for Verification
                </button>
                <button
                  onClick={() => setSelectedReport(null)}
                  className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
