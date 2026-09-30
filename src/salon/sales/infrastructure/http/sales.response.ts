import { ApiProperty } from '@nestjs/swagger';

import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { Invoice } from '../../domain/invoice.entity';
import type { Payment } from '../../domain/payment.entity';
import type { SalesNames } from '../../domain/sales.repositories';
import type { SalesSummary } from '../../application/sales.use-cases';

/**
 * Presentador de ventas (ADR-0014, ADR-0018).
 *
 * Los importes salen como **cadena decimal**: un `numeric` de PostgreSQL no cabe exacto en
 * un `number` de JavaScript (ADR-0010).
 */
export class InvoiceLineResponse {
  id!: string;
  kind!: string;
  productId!: string | null;
  serviceId!: string | null;
  stylistId!: string | null;
  @ApiProperty({ nullable: true, type: String }) stylistName!: string | null;
  description!: string;
  quantity!: string;
  unitPrice!: string;
  discountAmount!: string;
  taxRate!: string;
  taxAmount!: string;
  lineSubtotal!: string;
  lineTotal!: string;
  commissionAmount!: string;
}

export class PaymentResponse {
  id!: string;
  method!: string;
  status!: string;
  amount!: string;
  refundedAmount!: string;
  currency!: string;
  reference!: string | null;
  receivedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) refundedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) refundReason!: string | null;
}

export class InvoiceResponse {
  id!: string;
  number!: string;
  status!: string;
  clientId!: string | null;
  @ApiProperty({ nullable: true, type: String }) clientName!: string | null;
  /** Quién registró la venta: la cajera que la cobró. */
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  appointmentId!: string | null;
  issuedAt!: Date | null;
  dueAt!: Date | null;
  paidAt!: Date | null;
  voidedAt!: Date | null;
  voidReason!: string | null;
  subtotal!: string;
  discountTotal!: string;
  taxTotal!: string;
  total!: string;
  paidTotal!: string;
  balanceDue!: string;
  commissionTotal!: string;
  currency!: string;
  notes!: string | null;
  @ApiProperty({ type: [InvoiceLineResponse] }) lines!: InvoiceLineResponse[];
  @ApiProperty({ type: [PaymentResponse], required: false }) payments?: PaymentResponse[];
}

export const toInvoiceResponse = (
  invoice: Invoice,
  payments?: readonly Payment[],
  names?: SalesNames,
): InvoiceResponse => ({
  id: invoice.id,
  number: invoice.number,
  status: invoice.status,
  clientId: invoice.clientId,
  clientName: (invoice.clientId && names?.clients.get(invoice.clientId)) || null,
  createdByName: (invoice.audit.createdBy && names?.users.get(invoice.audit.createdBy)) || null,
  appointmentId: invoice.appointmentId,
  issuedAt: invoice.issuedAt,
  dueAt: invoice.dueAt,
  paidAt: invoice.paidAt,
  voidedAt: invoice.voidedAt,
  voidReason: invoice.voidReason,
  subtotal: invoice.subtotal.toDecimalString(),
  discountTotal: invoice.discountTotal.toDecimalString(),
  taxTotal: invoice.taxTotal.toDecimalString(),
  total: invoice.total.toDecimalString(),
  paidTotal: invoice.paidTotal.toDecimalString(),
  balanceDue: invoice.balanceDue.toDecimalString(),
  commissionTotal: invoice.commissionTotal.toDecimalString(),
  currency: invoice.currency,
  notes: invoice.notes,
  lines: invoice.lines.map((line) => ({
    id: line.id,
    kind: line.kind,
    productId: line.productId,
    serviceId: line.serviceId,
    stylistId: line.stylistId,
    stylistName: (line.stylistId && names?.stylists.get(line.stylistId)) || null,
    description: line.description,
    quantity: line.quantity.toFixed(3),
    unitPrice: line.unitPrice.toDecimalString(),
    discountAmount: line.discountAmount.toDecimalString(),
    taxRate: line.taxRate.value.toFixed(2),
    taxAmount: line.taxAmount.toDecimalString(),
    lineSubtotal: line.lineSubtotal.toDecimalString(),
    lineTotal: line.lineTotal.toDecimalString(),
    commissionAmount: line.commissionAmount.toDecimalString(),
  })),
  ...(payments
    ? {
        payments: payments.map((payment) => ({
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amount: payment.amount.toDecimalString(),
          refundedAmount: payment.refundedAmount.toDecimalString(),
          currency: payment.amount.currency,
          reference: payment.reference,
          receivedAt: payment.receivedAt,
          refundedAt: payment.refundedAt,
          refundReason: payment.refundReason,
        })),
      }
    : {}),
});

// ---------------------------------------------------------------------------
// Envolturas HTTP (ResponseEnvelopeInterceptor)
// ---------------------------------------------------------------------------

export class InvoiceEnvelopeResponse {
  @ApiProperty({ type: InvoiceResponse }) data!: InvoiceResponse;
}

export class PaymentMethodTotalsResponse {
  method!: string;
  received!: string;
  refunded!: string;
  /** Cobrado menos devuelto: lo que debe haber quedado por ese medio. */
  net!: string;
}

export class SalesSummaryResponse {
  count!: number;
  total!: string;
  discountTotal!: string;
  voidCount!: number;
  currency!: string;
  @ApiProperty({ type: [PaymentMethodTotalsResponse] }) byMethod!: PaymentMethodTotalsResponse[];
}

export const toSalesSummaryResponse = (
  summary: SalesSummary,
  currency: string,
): SalesSummaryResponse => ({
  count: summary.invoices.count,
  total: summary.invoices.total.toDecimalString(),
  discountTotal: summary.invoices.discountTotal.toDecimalString(),
  voidCount: summary.invoices.voidCount,
  currency,
  byMethod: summary.byMethod.map((row) => ({
    method: row.method,
    received: row.received.toDecimalString(),
    refunded: row.refunded.toDecimalString(),
    net: row.received.subtract(row.refunded).toDecimalString(),
  })),
});

export class SalesSummaryEnvelopeResponse {
  @ApiProperty({ type: SalesSummaryResponse }) data!: SalesSummaryResponse;
}

export class InvoicePageResponse {
  @ApiProperty({ type: [InvoiceResponse] }) data!: InvoiceResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}
