import type { PageMeta } from '@/lib/pagination';
import { Button } from './button';
export function Pagination({
  meta,
  pending,
  onPage,
}: {
  meta?: PageMeta;
  pending?: boolean;
  onPage: (page: number) => void;
}) {
  if (!meta || meta.totalPages <= 1) return null;
  return (
    <nav aria-label="Paginación" className="flex flex-wrap items-center justify-center gap-3 py-4">
      <Button
        variant="outline"
        disabled={pending || !meta.hasPrevious}
        onClick={() => onPage(meta.page - 1)}
      >
        Anterior
      </Button>
      <span>
        Página {meta.page} de {meta.totalPages} · {meta.total} resultados
      </span>
      <Button
        variant="outline"
        disabled={pending || !meta.hasNext}
        onClick={() => onPage(meta.page + 1)}
      >
        Siguiente
      </Button>
    </nav>
  );
}
