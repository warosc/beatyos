import { ApiProperty } from '@nestjs/swagger';

import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { CashSessionView } from '../../application/cash.use-cases';
import type { CashMovement } from '../../domain/cash-session.entity';

/**
 * Presentadores de caja (ADR-0014).
 *
 * `cashSales` y `expectedAmount` cuelgan de la sesión aunque por dentro no formen parte del
 * agregado: son la forma que `apps/web` ya consumía. Los importes salen siempre como
 * **cadena decimal** (ADR-0010).
 */
export class CashMovementResponse {
  id!: string;
  type!: string;
  amount!: string;
  currency!: string;
  concept!: string;
  reference!: string | null;
  notes!: string | null;
  occurredAt!: Date;
}

export const toCashMovementResponse = (movement: CashMovement): CashMovementResponse => ({
  id: movement.id,
  type: movement.type,
  amount: movement.amount.toDecimalString(),
  currency: movement.amount.currency,
  concept: movement.concept,
  reference: movement.reference,
  notes: movement.notes,
  occurredAt: movement.occurredAt,
});

export class CashSessionResponse {
  id!: string;
  status!: string;
  openedAt!: Date;
  openedById!: string;
  closedAt!: Date | null;
  closedById!: string | null;
  openingFloat!: string;
  cashSales!: string;
  netMovements!: string;
  expectedAmount!: string;
  countedAmount!: string | null;
  difference!: string | null;
  currency!: string;
  notes!: string | null;
  @ApiProperty({ type: [CashMovementResponse] }) movements!: CashMovementResponse[];
}

export const toCashSessionResponse = (view: CashSessionView): CashSessionResponse => {
  const { session } = view;

  return {
    id: session.id,
    status: session.status,
    openedAt: session.openedAt,
    openedById: session.openedById,
    closedAt: session.closedAt,
    closedById: session.closedById,
    openingFloat: session.openingFloat.toDecimalString(),
    cashSales: view.cashSales.toDecimalString(),
    netMovements: session.netMovements.toDecimalString(),
    expectedAmount: view.expectedAmount.toDecimalString(),
    countedAmount: session.countedAmount?.toDecimalString() ?? null,
    difference: session.difference?.toDecimalString() ?? null,
    currency: session.currency,
    notes: session.notes,
    movements: session.movements.map(toCashMovementResponse),
  };
};

export class RecordCashMovementResponse extends CashMovementResponse {
  @ApiProperty({ type: CashSessionResponse }) session!: CashSessionResponse;
}

// ---------------------------------------------------------------------------
// Envolturas HTTP (ResponseEnvelopeInterceptor)
// ---------------------------------------------------------------------------

/** `GET /cash/current` devuelve `{ data: null }` cuando no hay caja abierta. */
export class CashSessionEnvelopeResponse {
  @ApiProperty({ type: CashSessionResponse, nullable: true }) data!: CashSessionResponse | null;
}

export class CashSessionPageResponse {
  @ApiProperty({ type: [CashSessionResponse] }) data!: CashSessionResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}

export class RecordCashMovementEnvelopeResponse {
  @ApiProperty({ type: RecordCashMovementResponse }) data!: RecordCashMovementResponse;
}
