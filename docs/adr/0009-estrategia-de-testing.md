# ADR-0009: Pirámide de tests y umbral de cobertura

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

El objetivo es 90% de cobertura. Una cobertura alta obtenida con tests que ejercitan
mocks de mocks da confianza falsa y frena el refactor en lugar de habilitarlo. El umbral
es una consecuencia deseable de tests buenos, no el objetivo en sí.

## Decisión

**Dos suites con contratos distintos**, ejecutables por separado:

| Suite | Ámbito | Dobles | Velocidad | Comando |
| ----- | ------ | ------ | --------- | ------- |
| `unit` | Dominio y casos de uso | Repositorios en memoria (implementaciones reales del puerto, no mocks) | ms | `npm run test:unit` |
| `integration` | Adaptadores, HTTP, SQL, tenancy | Ninguno: PostgreSQL real | s | `npm run test:integration` |

Reglas:

1. **Los dobles implementan el puerto de verdad.** `InMemoryClientRepository` respeta las
   mismas invariantes (unicidad, soft delete, ámbito de tenant) que el adaptador Prisma.
   Un mock que devuelve `undefined` no prueba nada; una implementación en memoria sí.
2. **Toda regla de negocio se prueba en `unit`.** Si una regla solo se puede probar por
   HTTP, está en la capa equivocada: eso es una señal de diseño, no un problema de tests.
3. **`integration` prueba lo que `unit` no puede**: SQL real, transacciones, restricciones
   únicas, índices parciales de soft delete, guards, filtros y **fuga entre inquilinos**.
4. **Umbral 90%** (sentencias / líneas / funciones) y **80% en ramas**, aplicado en CI.
   Se excluyen `*.module.ts`, DTOs y `main.ts`: son cableado declarativo cuya cobertura
   inflaría la cifra sin añadir confianza.
5. Los tests de seguridad son de primera clase: un usuario del salón A **debe** recibir 404
   al pedir un recurso del salón B.

## Consecuencias

- La suite `integration` necesita Docker: `docker compose up -d postgres-test`.
- Mantener repositorios en memoria tiene coste; se compensa con una batería de tests
  de contrato compartida que se ejecuta contra **ambas** implementaciones, garantizando
  que no divergen. Sin eso, el doble en memoria acaba mintiendo.
- El umbral puede empujar a escribir tests de relleno. La revisión de código rechaza tests
  que no afirmen comportamiento observable, aunque suban la cifra.
