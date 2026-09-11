export default function Loading() {
  return (
    <div aria-label="Cargando panel" role="status" className="animate-pulse space-y-6">
      <div className="h-20 w-80 rounded-2xl bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div className="h-40 rounded-2xl bg-muted" key={i} />
        ))}
      </div>
      <div className="h-96 rounded-2xl bg-muted" />
    </div>
  );
}
