'use client';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import { IVA_RATE, includedTax } from '@/lib/tax';
import { useDialog } from '@/lib/use-dialog';
import { money } from '@/lib/utils';
import { DialogClose } from '@/components/ui/dialog-close';

export type Product = {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  /** Lo que paga la clienta, con el IVA dentro (ADR-0021). */
  price: string;
  taxRate: string;
  /** La API lo omite a quien no tiene `products.read-cost`: hoy, solo la propietaria lo ve. */
  costPrice?: string;
  currency: string;
  stockOnHand: string;
  reorderPoint: string;
  reorderQuantity: string;
  stockStatus: 'AVAILABLE' | 'LOW' | 'OUT';
  /** Sin control de existencias (un bono, un servicio) no se recibe ni se ajusta. */
  trackStock?: boolean;
  /** Solo estos productos llevan número de lote y vencimiento al recibirlos. */
  tracksBatches?: boolean;
};

const cents = (value: string | number) => Math.round(Number(value) * 100);

/**
 * Alta y edición de un producto.
 *
 * La dueña escribe lo que cobra, con el IVA ya dentro, y eso es lo que guarda la API y lo que
 * se cobra en caja, al centavo. El IVA solo se muestra como dato interno.
 */
export function ProductDialog({
  product,
  onClose,
  onSaved,
}: {
  /** Sin producto es un alta. */
  product?: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAccess();
  const canSeeCosts = can('products.read-cost');
  const dialogRef = useDialog(onClose);
  const taxRate = product ? Number(product.taxRate) : IVA_RATE;
  const currentCents = product ? cents(product.price) : 0;
  const [salePrice, setSalePrice] = useState(product ? String(currentCents / 100) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const typedCents = salePrice === '' ? 0 : cents(salePrice);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (typedCents <= 0) return;
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    const costPrice = String(f.get('costPrice') ?? '').trim();
    const common = {
      name: f.get('name'),
      reorderPoint: Number(f.get('reorderPoint')),
      reorderQuantity: Number(f.get('reorderQuantity')),
    };
    const body = product
      ? {
          ...common,
          // Vacía, la marca se borra: la API guarda `null`.
          brand: String(f.get('brand') ?? ''),
          // Solo si cambia: un cambio de precio queda registrado aparte en la auditoría.
          ...(typedCents !== currentCents ? { price: typedCents / 100 } : {}),
          // Corregir el coste cambia la valoración del almacén: solo se manda si cambió.
          ...(costPrice && cents(costPrice) !== cents(product.costPrice ?? '')
            ? { costPrice: Number(costPrice) }
            : {}),
        }
      : {
          ...common,
          // El dominio solo admite letras, dígitos, punto, guion y guion bajo (y debe
          // empezar por letra o dígito). Normalizamos aquí lo que teclee la persona
          // usuaria para que un espacio o un acento no acaben en un 400 confuso.
          sku: String(f.get('sku') ?? '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9._-]+/g, '-')
            .replace(/^-+/, ''),
          brand: f.get('brand') || undefined,
          price: typedCents / 100,
          taxRate: IVA_RATE,
          // Vacío no es «cuesta cero»: se omite y la primera entrada de mercancía fija el coste.
          costPrice: costPrice ? Number(costPrice) : undefined,
        };
    const r = await sessionFetch(
      product
        ? `/api/inventory?resource=products&id=${encodeURIComponent(product.id)}`
        : '/api/inventory?resource=products',
      {
        method: product ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const p = (await r.json().catch(() => ({}))) as { detail?: string };
      setError(p.detail ?? 'No pudimos guardar el producto.');
      return;
    }
    onSaved();
  }

  const input = 'mt-1 h-11 w-full rounded-xl border bg-background px-3';
  const hint = 'mt-1 block text-xs font-normal text-muted-foreground';
  const title = product ? `Editar ${product.name}` : 'Nuevo producto';
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center"
    >
      <form
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="flex justify-between gap-3">
          <h2 className="font-display text-2xl font-semibold">
            {product ? 'Editar producto' : 'Nuevo producto'}
          </h2>
          <DialogClose onClose={onClose} />
        </div>
        {product ? (
          <p className="text-sm text-muted-foreground">
            SKU <strong className="text-foreground">{product.sku}</strong>
          </p>
        ) : (
          <label className="block text-sm font-semibold">
            SKU
            <input required name="sku" placeholder="Ej. SH-ARG-500" className={input} />
            <span className={hint}>
              Código corto del producto: letras, números, puntos y guiones.
            </span>
          </label>
        )}
        <label className="block text-sm font-semibold">
          Nombre
          <input required name="name" defaultValue={product?.name} className={input} />
        </label>
        <label className="block text-sm font-semibold">
          Marca (opcional)
          <input name="brand" defaultValue={product?.brand ?? ''} className={input} />
        </label>
        <label className="block text-sm font-semibold">
          Precio de venta (Q)
          <input
            required
            name="price"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={salePrice}
            onChange={(e) => setSalePrice(e.target.value)}
            className={input}
          />
          <span role="status" className={hint}>
            {typedCents > 0 ? (
              <>
                La clienta paga <strong>{money(typedCents / 100)}</strong>, lo mismo que verás en
                caja. Ya incluye {money(includedTax(typedCents, taxRate) / 100)} de IVA.
              </>
            ) : (
              'Lo que paga la clienta, con el IVA ya incluido.'
            )}
          </span>
        </label>
        {/* Quien no puede ver el coste tampoco lo escribe: la API lo rechazaría. */}
        {canSeeCosts && (
          <label className="block text-sm font-semibold">
            Costo sin IVA (opcional)
            <input
              name="costPrice"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              defaultValue={product?.costPrice ? Number(product.costPrice) : undefined}
              className={input}
            />
            <span className={hint}>
              Solo la propietaria ve este dato.
              {!product &&
                ' Si lo dejas vacío, se toma del costo de la primera entrada de mercancía.'}
            </span>
          </label>
        )}
        <label className="block text-sm font-semibold">
          Existencia mínima
          <input
            required
            name="reorderPoint"
            type="number"
            min={0}
            step="0.01"
            defaultValue={product ? Number(product.reorderPoint) : undefined}
            className={input}
          />
        </label>
        <label className="block text-sm font-semibold">
          Cantidad a reponer
          <input
            required
            name="reorderQuantity"
            type="number"
            min={0}
            step="0.01"
            defaultValue={product ? Number(product.reorderQuantity) : undefined}
            className={input}
          />
        </label>
        {product && (
          <p className="text-xs text-muted-foreground">
            Las ventas ya cobradas conservan el precio de entonces; el nuevo vale desde ahora. Las
            existencias se cambian con «Recibir» o «Ajustar».
          </p>
        )}
        {error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy}>
            {busy ? 'Guardando…' : product ? 'Guardar cambios' : 'Guardar'}
          </Button>
        </div>
      </form>
    </div>
  );
}
