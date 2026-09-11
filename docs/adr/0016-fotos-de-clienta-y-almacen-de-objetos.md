# ADR-0016: Fotos de clienta y almacén de objetos

- **Estado:** Aceptado
- **Fecha:** 2026-09-03
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0002](0002-stack-tecnologico.md), [ADR-0004](0004-soft-delete-y-auditoria.md)

## Contexto

Un salón necesita el antes y el después de cada servicio: es lo que permite enseñar a la
clienta lo que se hizo la última vez, repetir una fórmula de color y resolver una discusión
sobre el resultado. La foto de referencia que trae la clienta pertenece al mismo historial.

Dos cosas hacen que esto no sea «subir un fichero».

**La imagen de una persona es un dato personal.** No es un adjunto cualquiera: exige
consentimiento, es revocable, y su borrado tiene que llegar al fichero y no solo a una fila.

**Un fichero subido no es lo que dice ser.** El `Content-Type` y la extensión los escribe
quien sube, y ninguno se comprueba contra el contenido.

## Decisión

### 1. El fichero fuera de PostgreSQL, en un almacén de objetos

MinIO en desarrollo, S3/R2/Spaces en producción. La base guarda la referencia.

Un `bytea` de tres megas por foto infla las copias de seguridad, se pasea entero en cualquier
consulta que olvide excluir la columna y convierte un `pg_dump` de minutos en uno de horas.

MinIO se eligió frente a escribir en disco local porque habla el protocolo de S3: **el
código que se prueba en local es el que corre en producción**, no un primo suyo. El puerto
`ObjectStorage` no menciona buckets ni MinIO, y vive en `shared` porque el avatar del
profesional y la imagen de un producto son el mismo problema; tenerlo compartido evita que el
segundo caso traiga una segunda implementación (ADR-0002).

### 2. El tipo se deduce del contenido, nunca de lo que declare el cliente

`detectImageSignature` lee los bytes iniciales. Un HTML con un `<script>` dentro, llamado
`foto.jpg` y declarado `image/jpeg`, se rechaza antes de tocar el almacén; si se aceptara y
después se sirviera por una URL, sería ejecución de código en el dominio que sirve las fotos.

Es una **lista blanca** —JPEG, PNG, WebP, HEIC—, no una lista negra: con una lista negra
habría que acertar a enumerar todo lo peligroso y bastaría con olvidar uno. SVG queda fuera
aunque sea una imagen, porque admite `<script>` y un salón no necesita subir vectores.

No es la única capa. El objeto se guarda con el tipo verificado, con
`Content-Disposition: attachment` y con `X-Content-Type-Options: nosniff`, y un `CHECK` de
PostgreSQL exige que el `mimeType` empiece por `image/` incluso para una fila insertada a
mano.

### 3. La ruta la construye el sistema

`tenants/{tenantId}/clients/{clientId}/{año}/{mes}/{photoId}.{ext}`.

El prefijo por inquilino permite dar permisos por prefijo, medir lo que ocupa un salón y
borrarlo entero si se da de baja. La partición por mes evita el directorio con cien mil
objetos.

**Nada de lo que envía el cliente entra en la ruta.** Un nombre como
`../../otro-salon/foto.jpg` escaparía del prefijo, y la forma de impedirlo es no darle la
oportunidad en lugar de intentar limpiarlo. El nombre original se guarda solo para mostrarlo.

### 4. Sin consentimiento no se guarda, y publicar es otra decisión

`consentGivenAt` es una columna obligatoria, no una casilla en la interfaz: sin sitio donde
guardarlo, la única prueba de que se pidió sería la palabra de quien lo pidió. La comprobación
vive en el agregado, así que otra vía de subida chocaría con la misma pared. Queda además en
la auditoría, que es lo que hay que poder enseñar si alguien reclama.

`allowsMarketing` es un permiso **distinto**: consentir que la foto esté en la ficha no es
consentir que aparezca en el escaparate. Se puede retirar en cualquier momento —un
consentimiento es revocable por definición, y una interfaz que solo permitiera concederlo
sería una que no respeta lo que dice pedir—.

### 5. Borrar en dos tiempos: baja y purga

La baja oculta la foto y conserva el fichero. La purga, pasados unos días, lo borra del
almacén y sella `purgedAt`.

Separar los dos momentos es lo que permite deshacer una baja por error, porque lo segundo no
tiene vuelta atrás. Y tener el segundo paso es lo que hace que el derecho de supresión se
satisfaga de verdad: sin él, la foto desaparecería de la interfaz y seguiría en el disco.

Una foto purgada no se puede recuperar, y la base lo impone: `purgedAt` exige `deletedAt`.

### 6. Las URL se firman y caducan

El bucket no es público. Se firma una URL por petición, con quince minutos de vida, después
de que el guard de permisos haya autorizado: la firma no autoriza, solo transporta una
autorización ya concedida.

Las rutas no son secretas, así que un bucket público pondría las fotos de las clientas a un
`curl` de distancia para quien adivinara una. La galería firma todas las URL de una vez —es
una operación local, no llama al almacén— en lugar de exponer un endpoint por foto.

### 7. Deduplicación por huella

Subir dos veces la misma foto es corriente: la encargada no recuerda si ya lo hizo. Se busca
por SHA-256 del contenido **antes** de escribir en el almacén, y se devuelve la existente con
`deduplicated: true` —informado y no oculto, o volverá a intentarlo—.

## Consecuencias

**Lo que se gana.** El historial fotográfico completo, con trazabilidad de consentimiento y
un borrado que llega al fichero. Un almacén que escala sin tocar la base de datos y que
cambia de proveedor con tres variables de entorno.

**Lo que cuesta.** Una dependencia más en `docker-compose` y un proceso de purga que alguien
tiene que programar. Los objetos huérfanos son posibles —si la base falla tras escribir el
fichero— y solo ocupan espacio; el orden de los pasos está elegido para que el fallo caiga
siempre de ese lado y nunca del contrario, que sería una fila apuntando a un fichero
inexistente.

**Dos fallos que aparecieron al probar, ambos reales.**

El primero: `@Type(() => Boolean)` sobre un campo de formulario. `Boolean('false')` es
`true`, de modo que un cliente que enviara `allowsMarketing=false` **obtenía permiso de
publicación para una foto en la que se había denegado explícitamente**. El mismo patrón
estaba en el filtro `onlyAvailable` de inventario, filtrando al revés de lo pedido. Se
corrigió con un decorador `@BooleanParam()` compartido, con conversión por lista blanca.

El segundo: la purga borraba el fichero del almacén y la fila seguía diciendo que existía. La
extensión de Prisma impide por defecto que un `updateMany` alcance una fila ya borrada —y
hace bien, porque sería resucitar datos por la puerta de atrás (ADR-0004)—, pero purgar es
justo eso. El adaptador ahora declara ese ámbito explícitamente, y lo que hace correcto
levantarlo es que la operación no revive nada: la fila sigue borrada antes y después.

**Cobertura.** 26 tests de integración contra MinIO real —incluida la subida del HTML
disfrazado— y 50 unitarios entre la entidad, la detección de firmas y el decorador booleano.

## Alternativas descartadas

**Guardar la imagen en PostgreSQL como `bytea`.** Un solo sitio que respaldar y una
transacción para todo. Se descarta por el coste: las copias de seguridad y la replicación
pasan a mover gigabytes de imágenes, y una consulta que olvide excluir la columna arrastra la
foto entera.

**Subida directa con URL prefirmada (`presigned PUT`).** El cliente sube al almacén sin pasar
por la API, que deja de soportar el ancho de banda. Se descarta **precisamente porque la API
no vería el fichero**: no habría dónde comprobar los bytes mágicos ni calcular la huella, y la
defensa central de este ADR desaparecería. Con fotos de móvil de unos megas, el ahorro no
compensa. Si algún día hacen falta vídeos, la vía es prefirmar y validar después con una
notificación del almacén.

**Redimensionar y generar miniaturas al subir.** Es lo correcto para la galería y exige
`sharp`, una dependencia nativa que complica la imagen de Docker. Se deja fuera de este ADR y
el diseño no lo impide: `width`/`height` ya están, y una miniatura es otro objeto con otra
clave.

**Un modelo genérico `MediaAsset` con referencia polimórfica.** Serviría para fotos de
clienta, avatares y catálogo con una sola tabla. Se descarta porque una FK polimórfica no
tiene integridad referencial: nada impide que quede apuntando a una fila que ya no existe. La
garantía contra la duplicación está en el **puerto** `ObjectStorage`, que es donde importa;
cada dueño puede tener su tabla con su FK de verdad y sus reglas propias —el consentimiento
solo tiene sentido en las de clienta—.
