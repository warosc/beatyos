import { BusinessRuleViolationError, ConflictError } from '@shared/domain/errors';
import { FixedClock, SequentialIdGenerator } from '@shared/infrastructure/adapters/system.adapters';
import { InMemoryAuditRecorder } from '@test/doubles/auth.doubles';
import { InMemoryCategoryRepository, InMemoryServiceRepository } from '@test/doubles/salon.doubles';

import { Category } from '../domain/category.entity';
import {
  CreateCategoryUseCase,
  CreateServiceUseCase,
  DeleteCategoryUseCase,
  DeleteServiceUseCase,
  GetCategoryTreeUseCase,
  GetServiceUseCase,
  RestoreServiceUseCase,
  SearchCategoriesUseCase,
  SearchServicesUseCase,
  SetServiceConsumablesUseCase,
  UpdateCategoryUseCase,
  UpdateServiceUseCase,
} from './catalog.use-cases';

describe('Casos de uso de catálogo', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const NOW = new Date('2026-09-02T10:00:00.000Z');

  let services: InMemoryServiceRepository;
  let categories: InMemoryCategoryRepository;
  let audit: InMemoryAuditRecorder;
  let clock: FixedClock;
  let ids: SequentialIdGenerator;

  let createService: CreateServiceUseCase;
  let updateService: UpdateServiceUseCase;
  let getService: GetServiceUseCase;
  let searchServices: SearchServicesUseCase;
  let deleteService: DeleteServiceUseCase;
  let restoreService: RestoreServiceUseCase;
  let setConsumables: SetServiceConsumablesUseCase;
  let createCategory: CreateCategoryUseCase;
  let updateCategory: UpdateCategoryUseCase;
  let searchCategories: SearchCategoriesUseCase;
  let categoryTree: GetCategoryTreeUseCase;
  let deleteCategory: DeleteCategoryUseCase;

  beforeEach(() => {
    services = new InMemoryServiceRepository();
    categories = new InMemoryCategoryRepository();
    audit = new InMemoryAuditRecorder();
    clock = new FixedClock(NOW);
    ids = new SequentialIdGenerator();

    createService = new CreateServiceUseCase(services, categories, ids, clock, audit);
    updateService = new UpdateServiceUseCase(services, categories, clock, audit);
    getService = new GetServiceUseCase(services);
    searchServices = new SearchServicesUseCase(services);
    deleteService = new DeleteServiceUseCase(services, audit);
    restoreService = new RestoreServiceUseCase(services, audit);
    setConsumables = new SetServiceConsumablesUseCase(services, clock, audit);
    createCategory = new CreateCategoryUseCase(categories, ids, clock, audit);
    updateCategory = new UpdateCategoryUseCase(categories, clock, audit);
    searchCategories = new SearchCategoriesUseCase(categories);
    categoryTree = new GetCategoryTreeUseCase(categories);
    deleteCategory = new DeleteCategoryUseCase(categories, audit);
  });

  const newService = (overrides: Record<string, unknown> = {}) =>
    createService.execute({
      tenantId: TENANT,
      code: 'COR-M',
      name: 'Corte de señora',
      durationMinutes: 45,
      price: '25.00',
      currency: 'EUR',
      actorId: 'admin',
      ...overrides,
    });

  const seedCategory = (
    id: string,
    kind: 'SERVICE' | 'PRODUCT',
    parentId: string | null = null,
  ) => {
    const category = Category.create({
      id,
      tenantId: TENANT,
      kind,
      name: `Categoría ${id}`,
      parentId,
      now: NOW,
      actorId: null,
    });
    categories.seed(category);
    return category;
  };

  describe('servicios', () => {
    it('crea con impuestos calculados', async () => {
      const service = await newService();

      expect(service.code).toBe('COR-M');
      expect(service.priceWithTax.toDecimalString()).toBe('28.00');
      expect(audit.has('CREATE')).toBe(true);
    });

    it('rechaza un código repetido', async () => {
      await newService();

      const error = await newService({ name: 'Otro' })
        .then(() => new Error('se esperaba conflicto'))
        .catch((caught: Error) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('SERVICE_CODE_ALREADY_EXISTS');
    });

    it('avisa si el código pertenece a un servicio eliminado', async () => {
      const service = await newService();
      await deleteService.execute({ id: service.id, actorId: 'admin' });

      const error = await newService()
        .then(() => new Error('se esperaba conflicto'))
        .catch((caught: Error) => caught);

      // Mensaje útil —«recupérelo»— en lugar de un error de unicidad opaco.
      expect((error as ConflictError).code).toBe('SERVICE_CODE_EXISTS_DELETED');
    });

    it('rechaza una categoría de productos', async () => {
      seedCategory('cat-prod', 'PRODUCT');

      await expect(newService({ categoryId: 'cat-prod' })).rejects.toThrow(
        /no admite este elemento/,
      );
    });

    it('acepta una categoría de servicios', async () => {
      seedCategory('cat-svc', 'SERVICE');

      await expect(newService({ categoryId: 'cat-svc' })).resolves.toBeDefined();
    });

    it('actualiza el precio como operación diferenciada', async () => {
      const service = await newService();

      const updated = await updateService.execute({
        id: service.id,
        price: '30.00',
        actorId: 'admin',
      });

      expect(updated.price.toDecimalString()).toBe('30.00');
      const entry = audit.entries.find((e) => e.action === 'UPDATE');
      expect(entry!.before).toMatchObject({ price: '25.00' });
    });

    it('activa y desactiva', async () => {
      const service = await newService();

      const off = await updateService.execute({ id: service.id, isActive: false, actorId: 'x' });
      expect(off.isBookable()).toBe(false);

      const on = await updateService.execute({ id: service.id, isActive: true, actorId: 'x' });
      expect(on.isBookable()).toBe(true);
    });

    it('rechaza mover a una categoría de otro tipo', async () => {
      const service = await newService();
      seedCategory('cat-prod', 'PRODUCT');

      await expect(
        updateService.execute({ id: service.id, categoryId: 'cat-prod', actorId: 'x' }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });

    it('guarda el escandallo', async () => {
      const service = await newService();

      const updated = await setConsumables.execute({
        serviceId: service.id,
        consumables: [{ productId: 'prd-1', quantity: 0.15 }],
        actorId: 'x',
      });

      expect(updated.consumables).toHaveLength(1);
    });

    it('recupera un servicio eliminado', async () => {
      const service = await newService();
      await deleteService.execute({ id: service.id, actorId: 'x' });

      await expect(restoreService.execute({ id: service.id, actorId: 'x' })).resolves.toBeDefined();
      expect(audit.has('RESTORE')).toBe(true);
    });

    it('consulta y busca', async () => {
      const service = await newService();

      await expect(getService.execute(service.id)).resolves.toBeDefined();

      const page = await searchServices.execute({
        filter: { search: 'Corte' },
        page: { page: 1, limit: 20 },
      });
      expect(page.meta.total).toBe(1);
    });
  });

  describe('categorías', () => {
    it('crea una raíz', async () => {
      const category = await createCategory.execute({
        tenantId: TENANT,
        kind: 'SERVICE',
        name: 'Peluquería',
        actorId: 'admin',
      });

      expect(category.isRoot).toBe(true);
      expect(category.slug).toBe('peluqueria');
    });

    it('cuelga de una madre del mismo tipo', async () => {
      const parent = seedCategory('cat-parent', 'SERVICE');

      const child = await createCategory.execute({
        tenantId: TENANT,
        kind: 'SERVICE',
        name: 'Color',
        parentId: parent.id,
        actorId: 'admin',
      });

      expect(child.parentId).toBe(parent.id);
    });

    it('rechaza colgar de una madre de otro tipo', async () => {
      seedCategory('cat-prod', 'PRODUCT');

      await expect(
        createCategory.execute({
          tenantId: TENANT,
          kind: 'SERVICE',
          name: 'Color',
          parentId: 'cat-prod',
          actorId: 'admin',
        }),
      ).rejects.toThrow(/distinto tipo/);
    });

    it('admite hasta tres niveles', async () => {
      seedCategory('nivel-1', 'SERVICE');
      seedCategory('nivel-2', 'SERVICE', 'nivel-1');

      // Raíz, hija y nieta: tres niveles es el máximo permitido, no el primero prohibido.
      await expect(
        createCategory.execute({
          tenantId: TENANT,
          kind: 'SERVICE',
          name: 'Nivel 3',
          parentId: 'nivel-2',
          actorId: 'admin',
        }),
      ).resolves.toBeDefined();
    });

    it('rechaza un cuarto nivel', async () => {
      seedCategory('nivel-1', 'SERVICE');
      seedCategory('nivel-2', 'SERVICE', 'nivel-1');
      seedCategory('nivel-3', 'SERVICE', 'nivel-2');

      // Un árbol más profundo deja de ayudar a encontrar nada y convierte el menú en un
      // laberinto.
      await expect(
        createCategory.execute({
          tenantId: TENANT,
          kind: 'SERVICE',
          name: 'Nivel 4',
          parentId: 'nivel-3',
          actorId: 'admin',
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });

    it('mueve una categoría y detecta el ciclo', async () => {
      const parent = seedCategory('padre', 'SERVICE');
      seedCategory('hija', 'SERVICE', 'padre');

      await expect(
        updateCategory.execute({ id: parent.id, parentId: 'hija', actorId: 'x' }),
      ).rejects.toThrow(/descendientes/);
    });

    it('convierte en raíz con parentId null', async () => {
      seedCategory('padre', 'SERVICE');
      const child = seedCategory('hija', 'SERVICE', 'padre');

      const updated = await updateCategory.execute({
        id: child.id,
        parentId: null,
        actorId: 'x',
      });

      expect(updated.isRoot).toBe(true);
    });

    it('renombra sin tocar el slug', async () => {
      const category = await createCategory.execute({
        tenantId: TENANT,
        kind: 'SERVICE',
        name: 'Peluquería',
        actorId: 'admin',
      });

      const updated = await updateCategory.execute({
        id: category.id,
        name: 'Peluquería y Estética',
        actorId: 'x',
      });

      expect(updated.slug).toBe('peluqueria');
    });

    it('activa y desactiva', async () => {
      const category = seedCategory('cat-1', 'SERVICE');

      const updated = await updateCategory.execute({
        id: category.id,
        isActive: false,
        actorId: 'x',
      });

      expect(updated.isActive).toBe(false);
    });

    it('no elimina una categoría con hijos', async () => {
      seedCategory('padre', 'SERVICE');
      seedCategory('hija', 'SERVICE', 'padre');

      await expect(deleteCategory.execute({ id: 'padre', actorId: 'x' })).rejects.toThrow(
        /CATEGORY_NOT_EMPTY|Muévalos/,
      );
    });

    it('elimina una categoría vacía', async () => {
      seedCategory('sola', 'SERVICE');

      await expect(deleteCategory.execute({ id: 'sola', actorId: 'x' })).resolves.toBeUndefined();
      expect(audit.has('DELETE')).toBe(true);
    });

    it('devuelve el árbol de un tipo', async () => {
      seedCategory('svc-1', 'SERVICE');
      seedCategory('prod-1', 'PRODUCT');

      expect(await categoryTree.execute('SERVICE')).toHaveLength(1);
      expect(await categoryTree.execute('PRODUCT')).toHaveLength(1);
    });

    it('busca con filtros', async () => {
      seedCategory('svc-1', 'SERVICE');
      seedCategory('prod-1', 'PRODUCT');

      const page = await searchCategories.execute({
        filter: { kind: 'SERVICE' },
        page: { page: 1, limit: 20 },
      });

      expect(page.meta.total).toBe(1);
    });
  });
});
