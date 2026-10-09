'use client';
import { money } from '@/lib/utils';
import { PAYMENT_LABEL, type Sale, type TenantProfile } from './types';

const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('es-GT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * Comprobante de venta, en columna de 80 mm: sirve para impresora de tickets, para A4 y para
 * guardar en PDF. No es una factura electrónica y lo dice: la FEL de la SAT es otro documento.
 *
 * `cash` solo llega al imprimir en el momento del cobro: lo recibido y el vuelto no se
 * guardan, así que una reimpresión no los muestra.
 */
export function Receipt({
  sale,
  profile,
  cash,
}: {
  sale: Sale;
  profile?: TenantProfile | null;
  cash?: { tenderedCents: number; changeCents: number } | null;
}) {
  const voided = sale.status === 'VOID';
  return (
    <div className="print-area mx-auto w-full max-w-[80mm] bg-white p-4 font-mono text-[12px] leading-snug text-black">
      <header className="text-center">
        <p className="text-sm font-bold">{profile?.legalName || profile?.name || 'BeautyOS'}</p>
        {profile?.legalName && profile.name !== profile.legalName && <p>{profile.name}</p>}
        {profile?.taxId && <p>NIT: {profile.taxId}</p>}
        {(profile?.addressLine || profile?.city) && (
          <p>{[profile.addressLine, profile.city].filter(Boolean).join(', ')}</p>
        )}
        {profile?.phone && <p>Tel. {profile.phone}</p>}
      </header>

      <div className="my-2 border-y border-dashed border-black py-1 text-center">
        <p className="font-bold">COMPROBANTE DE VENTA</p>
        <p className="text-[10px]">No sustituye la factura electrónica (FEL)</p>
      </div>

      {voided && (
        <div className="mb-2 border-2 border-black p-1 text-center">
          <p className="text-base font-bold">ANULADA</p>
          <p>{dateTime(sale.voidedAt)}</p>
          {sale.voidReason && <p>Motivo: {sale.voidReason}</p>}
        </div>
      )}

      <dl className="space-y-0.5">
        <Pair label="No." value={sale.number} />
        <Pair label="Fecha" value={dateTime(sale.issuedAt)} />
        <Pair label="Clienta" value={sale.clientName ?? 'Clienta ocasional'} />
        {sale.createdByName && <Pair label="Atendió" value={sale.createdByName} />}
      </dl>

      <table className="mt-2 w-full border-t border-dashed border-black">
        <tbody>
          {sale.lines.map((line) => (
            <tr key={line.id} className="align-top">
              <td className="py-1 pr-2">
                <p>
                  {Number(line.quantity)} × {line.description}
                </p>
                {line.stylistName && <p className="text-[10px]">con {line.stylistName}</p>}
                {Number(line.discountAmount) > 0 && (
                  <p className="text-[10px]">Descuento −{money(line.discountAmount)}</p>
                )}
              </td>
              <td className="py-1 text-right whitespace-nowrap">{money(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-1 space-y-0.5 border-t border-dashed border-black pt-1">
        {/* Precios y descuentos con IVA incluido (ADR-0021): el impuesto se desglosa, no se
            suma. El subtotal es lo que se habría pagado sin descuentos. */}
        {Number(sale.discountTotal) > 0 && (
          <>
            <Pair label="Subtotal" value={money(Number(sale.total) + Number(sale.discountTotal))} />
            <Pair label="Descuentos" value={`−${money(sale.discountTotal)}`} />
          </>
        )}
        <div className="flex justify-between text-sm font-bold">
          <dt>TOTAL</dt>
          <dd>{money(sale.total)}</dd>
        </div>
        <Pair label="IVA incluido" value={money(sale.taxTotal)} />
      </dl>

      {!!sale.payments?.length && (
        <dl className="mt-1 space-y-0.5 border-t border-dashed border-black pt-1">
          {sale.payments.map((payment) => (
            <Pair
              key={payment.id}
              label={`${PAYMENT_LABEL[payment.method] ?? payment.method}${payment.reference ? ` (${payment.reference})` : ''}${payment.status === 'REFUNDED' ? ' · devuelto' : ''}`}
              value={money(payment.amount)}
            />
          ))}
          {cash && cash.tenderedCents > 0 && (
            <>
              <Pair label="Recibido" value={money(cash.tenderedCents / 100)} />
              <Pair label="Vuelto" value={money(cash.changeCents / 100)} />
            </>
          )}
        </dl>
      )}

      {profile?.receiptNote && (
        <p className="mt-3 text-center whitespace-pre-line">{profile.receiptNote}</p>
      )}
      <p className="mt-3 text-center">¡Gracias por su visita!</p>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
