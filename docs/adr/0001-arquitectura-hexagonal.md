# ADR-0001: Arquitectura hexagonal con DDD por módulos

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

La plataforma debe soportar una superficie funcional amplia (agenda, inventario, compras,
caja, reportes) que crecerá durante años. El riesgo dominante en un sistema así no es el
rendimiento sino el **acoplamiento**: reglas de negocio dispersas entre controladores y
consultas SQL, imposibles de probar sin infraestructura y de cambiar sin regresiones.

## Decisión

Adoptamos **arquitectura hexagonal (puertos y adaptadores)** con **DDD táctico por módulo**.

Cada módulo de negocio es un slice vertical con tres capas y una regla de dependencia
estricta: **las dependencias apuntan siempre hacia dentro.**

```
src/<contexto>/<modulo>/
├── domain/            # Entidades, value objects, invariantes, puertos, errores
│   ├── *.entity.ts
│   ├── *.repository.ts        <- PUERTO (interface), no implementación
│   └── *.errors.ts
├── application/       # Casos de uso, orquestación, DTOs de entrada/salida
│   ├── use-cases/
│   └── dto/
└── infrastructure/    # ADAPTADORES: Prisma, HTTP, mensajería
    ├── persistence/prisma-*.repository.ts
    ├── http/*.controller.ts
    └── *.module.ts    <- único lugar donde se cablean puertos con adaptadores
```

Reglas verificables:

1. `domain/` no importa NADA de `application/`, `infrastructure/`, NestJS ni Prisma.
2. `application/` importa solo de `domain/` y del shared kernel de aplicación.
3. `infrastructure/` puede importar de ambas; nadie importa de `infrastructure/`
   salvo el propio `*.module.ts`.
4. La inyección se hace por **token de puerto** (`Symbol`), nunca por clase concreta.

## Consecuencias

**Positivas**

- La lógica de negocio se prueba con dobles en memoria, sin Postgres ni HTTP: tests
  unitarios de milisegundos, lo que hace alcanzable el umbral de cobertura del 90%.
- Prisma es reemplazable: se cambia el adaptador de persistencia, no el dominio.
- Los límites de módulo hacen visible el acoplamiento accidental en la revisión de código.

**Negativas**

- Más ficheros y una capa de mapeo entidad-dominio ↔ modelo-persistencia. Es coste real
  y deliberado: se paga una vez por entidad y se amortiza en cada cambio posterior.
- Riesgo de sobre-ingeniería en módulos anémicos (p.ej. catálogos). Se mitiga permitiendo
  casos de uso CRUD genéricos reutilizables (ver ADR-0002, sección de no-duplicación).

## Alternativas descartadas

- **Arquitectura en capas clásica (controller → service → repository).** Más barata al
  inicio, pero el "service" acaba siendo un cajón de sastre acoplado al ORM. Es exactamente
  el patrón que este proyecto existe para evitar.
- **Microservicios desde el día uno.** Coste operativo injustificado sin carga ni equipos
  que lo demanden. Los límites de módulo actuales son la costura por la que se podría
  extraer un servicio más adelante si hiciera falta.
