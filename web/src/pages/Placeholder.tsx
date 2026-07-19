export default function Placeholder({ title }: { title: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="text-lg font-semibold text-stone-700">{title}</div>
        <div className="text-sm text-stone-400 mt-1">Coming in a later phase.</div>
      </div>
    </div>
  );
}
