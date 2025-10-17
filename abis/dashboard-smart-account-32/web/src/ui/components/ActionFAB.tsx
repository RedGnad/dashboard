import React from 'react';

interface ActionFABProps {
  onDashboard: () => void;
  onSettings: () => void;
}

export default function ActionFAB({ onDashboard, onSettings }: ActionFABProps) {
  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col gap-3">
      <button
        onClick={onDashboard}
        className="flex items-center gap-2 px-4 py-3 rounded-xl bg-white/10 text-white border border-white/20 backdrop-blur-md hover:bg-white/20 transition"
        title="Open DCA Dashboard"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
          <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" />
        </svg>
        <span className="text-sm font-medium">Dashboard</span>
      </button>
      <button
        onClick={onSettings}
        className="flex items-center gap-2 px-4 py-3 rounded-xl bg-white/10 text-white border border-white/20 backdrop-blur-md hover:bg-white/20 transition"
        title="Open Analytics"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
          <path d="M12 8a4 4 0 100 8 4 4 0 000-8zm9-2h-3.2a7.97 7.97 0 00-1.6-2.74l2.27-2.27-1.41-1.41-2.27 2.27A7.97 7.97 0 0014 1.2V-2h-2v3.2a7.97 7.97 0 00-2.74 1.6L6.99 0.53 5.58 1.94l2.27 2.27A7.97 7.97 0 006.2 6H3v2h3.2a7.97 7.97 0 001.6 2.74L5.53 13 6.94 14.41l2.27-2.27A7.97 7.97 0 0010 14.8V18h2v-3.2a7.97 7.97 0 002.74-1.6l2.27 2.27 1.41-1.41-2.27-2.27A7.97 7.97 0 0017.8 8H21V6z" />
        </svg>
        <span className="text-sm font-medium">Analytics</span>
      </button>
    </div>
  );
}
