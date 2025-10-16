interface BackgroundProps {
  className?: string;
}

export default function Background({ className }: BackgroundProps) {
  return (
    <div className={`fixed inset-0 ${className || ""}`}>
      {/* Base gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900 via-purple-800 to-indigo-900"></div>

      {/* Floating light orbs */}
      <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-purple-400/10 rounded-full blur-3xl animate-pulse"></div>
      <div className="absolute top-3/4 right-1/4 w-48 h-48 bg-indigo-400/12 rounded-full blur-2xl animate-pulse animation-delay-1000"></div>
      <div className="absolute top-1/2 left-3/4 w-32 h-32 bg-violet-400/15 rounded-full blur-xl animate-pulse animation-delay-2000"></div>

      {/* Light rays */}
      <div className="absolute top-0 left-1/3 w-1 h-full bg-gradient-to-b from-transparent via-purple-300/5 to-transparent transform rotate-12 animate-pulse"></div>
      <div className="absolute top-0 right-1/3 w-1 h-full bg-gradient-to-b from-transparent via-indigo-300/5 to-transparent transform -rotate-12 animate-pulse animation-delay-1500"></div>

      {/* Floating particles */}
      <div className="absolute top-1/3 left-1/2 w-2 h-2 bg-purple-300/20 rounded-full animate-float"></div>
      <div className="absolute top-2/3 left-1/3 w-1 h-1 bg-indigo-300/25 rounded-full animate-float animation-delay-3000"></div>
      <div className="absolute top-1/4 right-1/3 w-3 h-3 bg-violet-300/15 rounded-full animate-float animation-delay-1500"></div>
      
      {/* Additional atmospheric particles */}
      <div className="absolute top-1/6 left-2/3 w-1 h-1 bg-blue-300/30 rounded-full animate-float animation-delay-2000"></div>
      <div className="absolute bottom-1/4 left-1/6 w-2 h-2 bg-purple-400/20 rounded-full animate-float animation-delay-1000"></div>
    </div>
  );
}
