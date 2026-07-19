import { useEffect, useState } from "react";

export default function App() {
  const [status, setStatus] = useState<string>("checking…");

  useEffect(() => {
    fetch("/api/ping")
      .then((r) => r.json())
      .then((d) => setStatus(d?.ok ? "API ok" : "API responded, unexpected shape"))
      .catch(() => setStatus("API unreachable"));
  }, []);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-accent">Engineering Notebook</h1>
        <p className="mt-2 text-sm text-stone-500">{status}</p>
      </div>
    </div>
  );
}
