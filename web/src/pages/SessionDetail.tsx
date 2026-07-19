import { Link, useParams } from "react-router-dom";

// Stub — the full session viewer is built in Task 6.
export default function SessionDetail() {
  const { id } = useParams();
  return (
    <div className="max-w-3xl mx-auto p-6">
      <Link to="/" className="text-sm text-stone-500 hover:text-accent">&larr; Sessions</Link>
      <h1 className="text-xl font-semibold text-accent mt-2">Session {id}</h1>
      <p className="text-sm text-stone-500 mt-2">Viewer coming in Task 6.</p>
    </div>
  );
}
