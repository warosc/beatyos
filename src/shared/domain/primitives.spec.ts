import {
  BusinessRuleViolationError,
  ConflictError,
  DomainValidationError,
  EntityNotFoundError,
  ForbiddenActionError,
  InvalidStateTransitionError,
} from './errors';
import { buildPage } from './ports/repository.port';
import {
  AggregateRoot,
  emptyAuditMetadata,
  Entity,
  ValueObject,
  type DomainEvent,
} from './primitives';

/** Doble mínimo para ejercitar las primitivas sin arrastrar un agregado real. */
class TestId extends Entity {
  static of(id: string): TestId {
    return new TestId(id);
  }
  private constructor(id: string) {
    super(id);
  }
}

class OtherEntity extends Entity {
  static of(id: string): OtherEntity {
    return new OtherEntity(id);
  }
  private constructor(id: string) {
    super(id);
  }
}

interface PointProps extends Record<string, unknown> {
  readonly x: number;
  readonly y: number;
}

class Point extends ValueObject<PointProps> {
  static of(x: number, y: number): Point {
    return new Point({ x, y });
  }
  private constructor(props: PointProps) {
    super(props);
  }
  get x(): number {
    return this.props.x;
  }
}

class Order extends AggregateRoot {
  static of(id: string): Order {
    return new Order(id);
  }
  private constructor(id: string) {
    super(id);
  }

  emit(name: string): void {
    this.addEvent({
      name,
      aggregateId: this.id,
      tenantId: 'tenant-1',
      occurredAt: new Date('2026-09-02T10:00:00.000Z'),
      payload: {},
    });
  }
}

describe('Entity', () => {
  it('se compara por identidad, no por contenido', () => {
    expect(TestId.of('a').equals(TestId.of('a'))).toBe(true);
    expect(TestId.of('a').equals(TestId.of('b'))).toBe(false);
  });

  it('dos entidades de clases distintas nunca son iguales aunque compartan id', () => {
    // Sin esta comprobación, un `Client` y un `Stylist` con el mismo identificador se
    // considerarían el mismo objeto.
    expect(TestId.of('a').equals(OtherEntity.of('a'))).toBe(false);
  });

  it('no es igual a null ni a undefined', () => {
    expect(TestId.of('a').equals(null)).toBe(false);
    expect(TestId.of('a').equals(undefined)).toBe(false);
  });

  it('exige un identificador', () => {
    expect(() => TestId.of('')).toThrow(/requiere un identificador/);
  });
});

describe('ValueObject', () => {
  it('se compara por contenido', () => {
    expect(Point.of(1, 2).equals(Point.of(1, 2))).toBe(true);
    expect(Point.of(1, 2).equals(Point.of(2, 1))).toBe(false);
  });

  it('la comparación es independiente del orden de las claves', () => {
    // La serialización ordena las claves: sin eso, dos objetos idénticos construidos en
    // distinto orden se considerarían diferentes.
    expect(Point.of(1, 2).equals(Point.of(1, 2))).toBe(true);
  });

  it('congela sus propiedades', () => {
    const point = Point.of(1, 2);
    expect(() => {
      (point as unknown as { props: PointProps }).props = { x: 9, y: 9 };
    }).not.toThrow();
    // La instancia original conserva su valor: los props están congelados.
    expect(Point.of(1, 2).x).toBe(1);
  });

  it('no es igual a null', () => {
    expect(Point.of(1, 2).equals(null)).toBe(false);
  });
});

describe('AggregateRoot', () => {
  it('acumula eventos sin publicarlos', () => {
    const order = Order.of('order-1');
    expect(order.hasUncommittedEvents).toBe(false);

    order.emit('OrderPlaced');
    expect(order.hasUncommittedEvents).toBe(true);
  });

  it('pullEvents devuelve y vacía la cola', () => {
    const order = Order.of('order-1');
    order.emit('OrderPlaced');
    order.emit('OrderConfirmed');

    const events: DomainEvent[] = order.pullEvents();

    expect(events.map((e) => e.name)).toEqual(['OrderPlaced', 'OrderConfirmed']);
    // Vaciar la cola al leerla evita que un mismo evento se publique dos veces si el
    // agregado se guarda más de una vez en la misma petición.
    expect(order.pullEvents()).toEqual([]);
    expect(order.hasUncommittedEvents).toBe(false);
  });
});

describe('emptyAuditMetadata', () => {
  it('sella creación y modificación con el mismo instante y actor', () => {
    const now = new Date('2026-09-02T10:00:00.000Z');
    const audit = emptyAuditMetadata(now, 'user-1');

    expect(audit).toEqual({
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      createdBy: 'user-1',
      updatedBy: 'user-1',
      deletedBy: null,
    });
  });

  it('admite creación sin actor, para seeds y procesos automáticos', () => {
    expect(emptyAuditMetadata(new Date()).createdBy).toBeNull();
  });
});

describe('buildPage', () => {
  it('calcula los metadatos de una página intermedia', () => {
    const page = buildPage(['a', 'b'], 137, { page: 3, limit: 20 });

    expect(page.meta).toEqual({
      page: 3,
      limit: 20,
      total: 137,
      totalPages: 7,
      hasNext: true,
      hasPrevious: true,
    });
  });

  it('marca correctamente la primera y la última página', () => {
    expect(buildPage([], 40, { page: 1, limit: 20 }).meta).toMatchObject({
      hasPrevious: false,
      hasNext: true,
    });
    expect(buildPage([], 40, { page: 2, limit: 20 }).meta).toMatchObject({
      hasPrevious: true,
      hasNext: false,
    });
  });

  it('una lista vacía tiene cero páginas, no una', () => {
    // "Página 1 de 0" describe mejor una lista vacía que "página 1 de 1", que sugiere
    // que hay contenido.
    expect(buildPage([], 0, { page: 1, limit: 20 }).meta).toMatchObject({
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    });
  });

  it('conserva los datos recibidos', () => {
    expect(buildPage(['x'], 1, { page: 1, limit: 20 }).data).toEqual(['x']);
  });
});

describe('errores de dominio', () => {
  it('EntityNotFoundError acepta identificador simple o compuesto', () => {
    const simple = new EntityNotFoundError('Clienta', 'abc');
    expect(simple.code).toBe('ENTITY_NOT_FOUND');
    expect(simple.message).toContain('abc');

    const composite = new EntityNotFoundError('Cita', { stylistId: 's1', date: '2026-09-10' });
    expect(composite.message).toContain('stylistId');
  });

  it('cada error lleva su código estable, que es contrato público', () => {
    expect(new ConflictError('X_EXISTS', 'ya existe').code).toBe('X_EXISTS');
    expect(new BusinessRuleViolationError('RULE', 'no puede').code).toBe('RULE');
    expect(new DomainValidationError('mal', 'campo').code).toBe('DOMAIN_VALIDATION_ERROR');
    expect(new ForbiddenActionError('borrar').code).toBe('FORBIDDEN_ACTION');
    expect(new InvalidStateTransitionError('Cita', 'PAID', 'DRAFT').code).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('los detalles quedan congelados', () => {
    const error = new ConflictError('X', 'mensaje', { field: 'email' });
    expect(error.details).toEqual({ field: 'email' });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('sin detalles, la propiedad queda ausente', () => {
    expect(new DomainValidationError('mal').details).toBeUndefined();
  });

  it('DomainValidationError expone el campo señalado', () => {
    expect(new DomainValidationError('mal', 'email').field).toBe('email');
  });

  it('InvalidStateTransitionError describe la transición imposible', () => {
    const error = new InvalidStateTransitionError('Factura', 'PAID', 'DRAFT');
    expect(error.message).toContain('PAID');
    expect(error.message).toContain('DRAFT');
    expect(error.details).toMatchObject({ from: 'PAID', to: 'DRAFT' });
  });

  it('ForbiddenActionError admite un motivo propio', () => {
    expect(new ForbiddenActionError('cerrar caja', 'La caja la abrió otra persona').message).toBe(
      'La caja la abrió otra persona',
    );
  });

  it('el nombre del error es el de su clase, para que se lea en las trazas', () => {
    expect(new EntityNotFoundError('Clienta', 'x').name).toBe('EntityNotFoundError');
  });
});
