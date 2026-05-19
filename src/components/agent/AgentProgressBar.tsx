"use client";

export function AgentProgressBar({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="absolute inset-x-0 top-0 z-10 h-0.5 bg-white/5">
      <div
        className="h-full animate-pulse"
        style={{
          background: "linear-gradient(90deg, #8b5cf6, #a78bfa, #8b5cf6)",
          backgroundSize: "200% 100%",
          animation: "shimmer 1.5s linear infinite",
        }}
      />
      <style jsx>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
