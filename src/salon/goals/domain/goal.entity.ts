import { DomainValidationError } from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';

/**
 * Meta de facturación de una profesional, con su recompensa.
 *
 * No es una plantilla recurrente: cada periodo que la propietaria quiera premiar crea una
 * fila nueva. El progreso no vive aquí — se calcula sumando las líneas de venta del
 * periodo, igual que el resto de indicadores de la app — pero `achievedAt` sí se guarda, y
 * es de una sola dirección: una vez fijado no se retira, aunque una venta se anule después
 * y el progreso «real» baje. La recompensa, si se cumplió, ya se entregó.
 */

export type GoalMetricValue = 'SERVICE_REVENUE' | 'PRODUCT_REVENUE';
export type GoalStatusValue = 'ACTIVE' | 'ACHIEVED' | 'EXPIRED';

export interface GoalProps {
  readonly tenantId: string;
  readonly stylistId: string;
  readonly metric: GoalMetricValue;
  readonly targetAmount: Money;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly rewardDescription: string;
  readonly achievedAt: Date | null;
  readonly audit: AuditMetadata;
}

export class Goal extends Entity {
  private constructor(
    id: string,
    private props: GoalProps,
  ) {
    super(id);
  }

  static define(params: {
    id: string;
    tenantId: string;
    stylistId: string;
    metric: GoalMetricValue;
    targetAmount: Money;
    periodStart: Date;
    periodEnd: Date;
    rewardDescription: string;
    now: Date;
    actorId: string | null;
  }): Goal {
    if (params.targetAmount.isNegative() || params.targetAmount.isZero()) {
      throw new DomainValidationError('El objetivo debe ser mayor que cero', 'targetAmount');
    }
    if (params.periodEnd.getTime() <= params.periodStart.getTime()) {
      throw new DomainValidationError(
        'El fin del periodo debe ser posterior al inicio',
        'periodEnd',
      );
    }
    const rewardDescription = params.rewardDescription?.trim();
    if (!rewardDescription) {
      throw new DomainValidationError('Describa la recompensa', 'rewardDescription');
    }

    return new Goal(params.id, {
      tenantId: params.tenantId,
      stylistId: params.stylistId,
      metric: params.metric,
      targetAmount: params.targetAmount,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      rewardDescription,
      achievedAt: null,
      audit: {
        createdAt: params.now,
        updatedAt: params.now,
        deletedAt: null,
        createdBy: params.actorId,
        updatedBy: params.actorId,
        deletedBy: null,
      },
    });
  }

  static rehydrate(id: string, props: GoalProps): Goal {
    return new Goal(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get stylistId(): string {
    return this.props.stylistId;
  }
  get metric(): GoalMetricValue {
    return this.props.metric;
  }
  get targetAmount(): Money {
    return this.props.targetAmount;
  }
  get periodStart(): Date {
    return this.props.periodStart;
  }
  get periodEnd(): Date {
    return this.props.periodEnd;
  }
  get rewardDescription(): string {
    return this.props.rewardDescription;
  }
  get achievedAt(): Date | null {
    return this.props.achievedAt;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isAchieved(): boolean {
    return this.props.achievedAt !== null;
  }

  /** Estado para pintar en pantalla. `now` es externo a propósito: no depende de cuándo se guardó. */
  statusAt(now: Date): GoalStatusValue {
    if (this.isAchieved) return 'ACHIEVED';
    if (now.getTime() > this.props.periodEnd.getTime()) return 'EXPIRED';
    return 'ACTIVE';
  }

  // -- Comportamiento ---------------------------------------------------------

  /** Idempotente: si ya estaba cumplida, no hace nada — nunca se puede «des-cumplir». */
  markAchieved(now: Date): void {
    if (this.props.achievedAt) return;
    this.props = {
      ...this.props,
      achievedAt: now,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  markDeleted(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: now,
        deletedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }
}
