import { NavLink } from "react-router-dom";
import { TranscriptTogglesProvider, TranscriptToggleButtons } from "../session/toggleContext";

const navCls = ({ isActive }: { isActive: boolean }) =>
  `px-3 h-11 flex items-center text-sm border-b-2 ${
    isActive ? "border-accent text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"
  }`;

// Top bar + a full-height content area. Pages render their own panels.
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <TranscriptTogglesProvider>
      <div className="h-screen flex flex-col bg-white text-stone-900">
        <header className="h-11 flex items-center px-5 border-b border-stone-200 shrink-0">
          <span className="font-serif font-bold text-[15px] mr-8">Engineering Notebook</span>
          <nav className="flex items-stretch h-11">
            <NavLink to="/" className={navCls} end>Journal</NavLink>
            <NavLink to="/projects" className={navCls}>Projects</NavLink>
            <NavLink to="/calendar" className={navCls}>Calendar</NavLink>
            <NavLink to="/groups" className={navCls}>Groups</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <TranscriptToggleButtons />
            <input
              className="text-sm border border-stone-300 rounded px-2 py-1 w-48 focus:outline-none focus:border-accent"
              placeholder="Search…"
              disabled
              title="Search — coming soon"
            />
            <span className="text-stone-400" title="Settings — coming soon">&#9881;</span>
          </div>
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </TranscriptTogglesProvider>
  );
}

// Three-panel row: index · entries · detail. Each panel scrolls independently.
export function ThreePanel({ index, entries, detail }: { index: React.ReactNode; entries: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="h-full flex">
      <div className="w-64 shrink-0 overflow-y-auto border-r border-stone-200">{index}</div>
      <div className="w-96 shrink-0 overflow-y-auto border-r border-stone-200">{entries}</div>
      <div className="flex-1 overflow-y-auto">{detail}</div>
    </div>
  );
}
