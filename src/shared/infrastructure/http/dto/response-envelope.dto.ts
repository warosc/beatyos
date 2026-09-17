import { ApiProperty } from '@nestjs/swagger';

/**
 * Forma HTTP real de una respuesta sin cuerpo tras `ResponseEnvelopeInterceptor`.
 *
 * Vive aquí, compartida, porque cada operación de borrado de cada módulo la usa igual
 * (`{ data: null }`): declararla de nuevo en cada `*.response.ts` registraría varias clases
 * con el mismo nombre en el documento OpenAPI.
 */
export class EmptyEnvelopeResponse {
  @ApiProperty({ type: () => Object, nullable: true, example: null }) data!: unknown;
}
