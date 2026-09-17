import { ApiProperty } from '@nestjs/swagger';

import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { Invoice } from '../../domain/invoice.entity';
import type { Payment } from '../../domain/payment.entity';

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
}

export class InvoiceResponse {
  id!: string;
  number!: string;
  status!: string;
  clientId!: string | null;
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
): InvoiceResponse => ({
  id: invoice.id,
  number: invoice.number,
  status: invoice.status,
  clientId: invoice.clientId,
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

export class InvoicePageResponse {
  @ApiProperty({ type: [InvoiceResponse] }) data!: InvoiceResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}
