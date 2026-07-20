import { createContext, useContext, useState, type ReactNode } from "react";

type Toggles = {
  showThinking: boolean;
  showTools: boolean;
  uncompacted: boolean;
  compactedAvailable: boolean;
  setShowThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setShowTools: React.Dispatch<React.SetStateAction<boolean>>;
  setUncompacted: React.Dispatch<React.SetStateAction<boolean>>;
  setCompactedAvailable: React.Dispatch<React.SetStateAction<boolean>>;
};

const Ctx = createContext<Toggles | null>(null);

export function useTranscriptToggles(): Toggles {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTranscriptToggles must be used within a TranscriptTogglesProvider");
  return c;
}

export function TranscriptTogglesProvider({ children }: { children: ReactNode }) {
  const [showThinking, setShowThinking] = useState(false);
  const [showTools, setShowTools] = useState(false);
  // Default to the uncompacted (full) transcript so pre-compaction detail is shown.
  const [uncompacted, setUncompacted] = useState(true);
  // Whether the current session actually has a compacted view to switch to.
  const [compactedAvailable, setCompactedAvailable] = useState(false);
  return (
    <Ctx.Provider
      value={{
        showThinking, showTools, uncompacted, compactedAvailable,
        setShowThinking, setShowTools, setUncompacted, setCompactedAvailable,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

// The Show/Hide thinking & tools buttons — rendered in the always-visible top bar.
export function TranscriptToggleButtons() {
  const { showThinking, showTools, uncompacted, compactedAvailable, setShowThinking, setShowTools, setUncompacted } = useTranscriptToggles();
  const cls = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-xs transition-colors ${active ? "bg-panel text-slate hover:text-ink" : "bg-teal-wash text-teal hover:text-ink"}`;
  return (
    <div className="flex gap-2">
      <button
        className={`${cls(uncompacted)} disabled:opacity-40 disabled:cursor-default disabled:hover:text-slate`}
        onClick={() => setUncompacted((v) => !v)}
        disabled={!compactedAvailable}
        title={compactedAvailable ? undefined : "This session was not compacted"}
      >
        {uncompacted ? "View compacted" : "View uncompacted"}
      </button>
      <button className={cls(showThinking)} onClick={() => setShowThinking((v) => !v)}>
        {showThinking ? "Hide thinking" : "Show thinking"}
      </button>
      <button className={cls(showTools)} onClick={() => setShowTools((v) => !v)}>
        {showTools ? "Hide tools" : "Show tools"}
      </button>
    </div>
  );
}
