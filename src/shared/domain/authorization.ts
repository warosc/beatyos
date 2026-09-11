/**
 * Constantes de autorización compartidas por el dominio y el guard.
 *
 * Vive en `shared/domain` y no junto al guard porque el dominio también decide sobre
 * permisos —`User.hasPermission()`— y una entidad no puede importar de infraestructura
 * sin romper la regla de dependencia del ADR-0001. Que el comodín estuviera declarado
 * en el guard obligaría exactamente a esa importación prohibida.
 */

/**
 * Comodín del administrador de plataforma: concede cualquier permiso.
 *
 * Se prefiere a enumerar los permisos uno a uno porque un permiso nuevo debe quedar
 * cubierto sin acordarse de añadirlo aquí. El precio es que este valor no puede
 * asignarse por descuido: solo lo lleva el rol `PLATFORM_ADMIN`, que se siembra y no es
 * editable desde la aplicación.
 */
export const WILDCARD_PERMISSION = '*';
