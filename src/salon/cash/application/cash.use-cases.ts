import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import { BusinessRuleViolationError, EntityNotFoundError } from '../../../shared/domain/errors';
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../sales/domain/sales.repositories';
import {
  CashSession,
  type CashMovement,
  type CashMovementTypeValue,
} from '../domain/cash-session.entity';
import {
  CASH_SESSION_REPOSITORY,
  type CashSessionFilter,
  type CashSessionRepository,
  type CashSessionSortField,
} from '../domain/cash.repositories';

/**
 * Vista de una caja con las cifras ya resueltas.
 *
 * `cashSales` no está en el agregado porque los cobros pertenecen a las facturas. Se une
 * aquí, en la aplicación, que es donde corresponde coordinar dos contextos sin que ninguno
 * de los dos tenga que conocer al otro.
 */
export interface CashSessionView {
  readonly session: CashSession;
  readonly cashSales: Money;
  readonly expectedAmount: Money;
}

// ---------------------------------------------------------------------------

@Injectable()
export class GetCurrentCashSessionUseCase implements UseCase<void, CashSessionView | null> {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY) private readonly sessions: CashSessionRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  async execute(): Promise<CashSessionView | null> {
    const session = await this.sessions.findOpen();
    return session ? viewOf(session, this.payments) : null;
  }
}

// ---------------------------------------------------------------------------

export interface OpenCashSessionInput {
  readonly tenantId: string;
  readonly openingFloat: string;
  readonly currency: string;
  readonly notes?: string | null;
  readonly actorId: string;
}

@Injectable()
export class OpenCashSessionUseCase implements UseCase<OpenCashSessionInput, CashSessionView> {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY) private readonly sessions: CashSessionRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: OpenCashSessionInput): Promise<CashSessionView> {
    // La comprobación previa da un mensaje útil; la garantía la aporta el índice único
    // parcial de la base, que es el único sitio donde dos peticiones simultáneas no pueden
    // colarse las dos.
    const existing = await this.sessions.findOpen();
    if (existing) {
      throw new BusinessRuleViolationError(
        'CASH_SESSION_ALREADY_OPEN',
        `Ya hay una caja abierta desde las ${existing.openedAt.toISOString()}. Ciérrela antes de abrir otra.`,
        { sessionId: existing.id },
      );
    }

    const session = await this.sessions.create(
      CashSession.open({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        openedById: input.actorId,
        openingFloat: Money.fromDecimal(input.openingFloat, input.currency),
        notes: input.notes ?? null,
        now: this.clock.now(),
        actorId: input.actorId,
      }),
    );

    await this.audit.record({
      action: 'CREATE',
      entityType: 'CashSession',
      entityId: session.id,
      after: { openingFloat: session.openingFloat.toDecimalString() },
    });

    return viewOf(session, this.payments);
  }
}

// ---------------------------------------------------------------------------

export interface RecordCashMovementInput {
  readonly type: CashMovementTypeValue;
  readonly amount: string;
  readonly concept: string;
  readonly reference?: string | null;
  readonly notes?: string | null;
  readonly actorId: string | null;
}

@Injectable()
export class RecordCashMovementUseCase implements UseCase<
  RecordCashMovementInput,
  { movement: CashMovement; view: CashSessionView }
> {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY) private readonly sessions: CashSessionRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(
    input: RecordCashMovementInput,
  ): Promise<{ movement: CashMovement; view: CashSessionView }> {
    const session = await requireOpenSession(this.sessions);

    const movement = session.recordMovement({
      id: this.ids.generate(),
      type: input.type,
      amount: Money.fromDecimal(input.amount, session.currency),
      concept: input.concept,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      now: this.clock.now(),
      actorId: input.actorId,
    });

    const saved = await this.sessions.update(session);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'CashMovement',
      entityId: movement.id,
      after: {
        sessionId: saved.id,
        type: movement.type,
        amount: movement.amount.toDecimalString(),
        concept: movement.concept,
      },
    });

    return { movement, view: await viewOf(saved, this.payments) };
  }
}

// ---------------------------------------------------------------------------

export interface CloseCashSessionInput {
  readonly countedAmount: string;
  readonly notes?: string | null;
  readonly actorId: string | null;
}

/**
 * Arqueo y cierre.
 *
 * No rechaza un descuadre. El dinero que hay en el cajón es el que hay, y una caja que solo
 * se deja cerrar cuando cuadra acaba cuadrando siempre porque alguien ajusta el recuento
 * hasta que el sistema lo acepta —que es exactamente el dato que se quería medir—.
 */
@Injectable()
export class CloseCashSessionUseCase implements UseCase<CloseCashSessionInput, CashSessionView> {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY) private readonly sessions: CashSessionRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CloseCashSessionInput): Promise<CashSessionView> {
    const session = await requireOpenSession(this.sessions);
    const cashSales = await this.payments.cashTotalForSession(session.id, session.currency);

    session.close({
      countedAmount: Money.fromDecimal(input.countedAmount, session.currency),
      cashSales,
      notes: input.notes ?? null,
      now: this.clock.now(),
      actorId: input.actorId,
    });

    const closed = await this.sessions.update(session);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'CashSession',
      entityId: closed.id,
      after: {
        countedAmount: closed.countedAmount?.toDecimalString(),
        expectedAmount: closed.expectedAmount(cashSales).toDecimalString(),
        difference: closed.difference?.toDecimalString(),
      },
    });

    return {
      session: closed,
      cashSales,
      expectedAmount: closed.expectedAmount(cashSales),
    };
  }
}

// ---------------------------------------------------------------------------

@Injectable()
export class SearchCashSessionsUseCase implements UseCase<
  { filter: CashSessionFilter; page: PageRequest<CashSessionSortField> },
  Page<CashSessionView>
> {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY) private readonly sessions: CashSessionRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  async execute(input: {
    filter: CashSessionFilter;
    page: PageRequest<CashSessionSortField>;
  }): Promise<Page<CashSessionView>> {
    const page = await this.sessions.search(input.filter, input.page);

    return {
      data: await Promise.all(page.data.map((session) => viewOf(session, this.payments))),
      meta: page.meta,
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Exige una caja abierta.
 *
 * El mensaje dice qué hacer —abrir la caja— en lugar de limitarse a constatar que no hay
 * ninguna. Es la diferencia entre un error que bloquea y uno que se resuelve solo.
 */
const requireOpenSession = async (sessions: CashSessionRepository): Promise<CashSession> => {
  const session = await sessions.findOpen();
  if (!session) {
    throw new EntityNotFoundError('Caja abierta', 'ninguna sesión activa');
  }
  return session;
};

const viewOf = async (
  session: CashSession,
  payments: PaymentRepository,
): Promise<CashSessionView> => {
  const cashSales = await payments.cashTotalForSession(session.id, session.currency);
  return { session, cashSales, expectedAmount: session.expectedAmount(cashSales) };
};
