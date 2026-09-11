import { detectImageSignature, readImageDimensions } from './image-signature';

/**
 * Ficheros mínimos de cada formato.
 *
 * Se construyen a mano en lugar de leerlos de disco: un test que depende de un fichero
 * binario en el repositorio es un test que nadie puede revisar en un diff, y aquí lo que se
 * comprueba son exactamente estos bytes.
 */
const jpeg = (extra: number[] = []) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...extra]);

const png = (width = 0, height = 0) => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const webp = () => {
  const buffer = Buffer.alloc(16);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(8, 4);
  buffer.write('WEBP', 8, 'ascii');
  return buffer;
};

const heic = (brand = 'heic') => {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32BE(12, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write(brand, 8, 'ascii');
  return buffer;
};

describe('detectImageSignature', () => {
  it('reconoce un JPEG', () => {
    expect(detectImageSignature(jpeg())).toEqual({ mimeType: 'image/jpeg', extension: 'jpg' });
  });

  it('reconoce un PNG', () => {
    expect(detectImageSignature(png())).toEqual({ mimeType: 'image/png', extension: 'png' });
  });

  it('reconoce un WebP por su contenedor RIFF', () => {
    expect(detectImageSignature(webp())).toEqual({ mimeType: 'image/webp', extension: 'webp' });
  });

  it('reconoce un HEIC, que es lo que sale de un iPhone', () => {
    expect(detectImageSignature(heic())).toEqual({ mimeType: 'image/heic', extension: 'heic' });
  });

  it('reconoce las demás marcas de la familia HEIF', () => {
    for (const brand of ['heix', 'mif1', 'hevc']) {
      expect(detectImageSignature(heic(brand))?.mimeType).toBe('image/heic');
    }
  });

  describe('lo que rechaza', () => {
    it('rechaza un HTML aunque se llame foto.jpg y se declare image/jpeg', () => {
      // Este es el ataque que justifica todo el módulo. Si se aceptara y después se sirviera
      // por una URL del almacén, el navegador ejecutaría el script.
      const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

      expect(detectImageSignature(html)).toBeNull();
    });

    it('rechaza un SVG, que es una imagen y admite scripts dentro', () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');

      expect(detectImageSignature(svg)).toBeNull();
    });

    it('rechaza un ejecutable con extensión de imagen', () => {
      const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

      expect(detectImageSignature(elf)).toBeNull();
    });

    it('rechaza un fichero vacío', () => {
      expect(detectImageSignature(Buffer.alloc(0))).toBeNull();
    });

    it('rechaza un fichero más corto que la firma que dice tener', () => {
      // Truncar en mitad de la firma no debe leer fuera del búfer ni dar un falso positivo.
      expect(detectImageSignature(Buffer.from([0xff, 0xd8]))).toBeNull();
      expect(detectImageSignature(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    });

    it('rechaza un RIFF que no es WebP', () => {
      // Un WAV también empieza por RIFF. La firma completa exige además la marca «WEBP».
      const wav = Buffer.alloc(16);
      wav.write('RIFF', 0, 'ascii');
      wav.write('WAVE', 8, 'ascii');

      expect(detectImageSignature(wav)).toBeNull();
    });

    it('rechaza una caja ftyp de un formato que no es imagen', () => {
      // Un MP4 comparte la estructura `ftyp` con HEIC y no es una foto.
      expect(detectImageSignature(heic('isom'))).toBeNull();
    });
  });
});

describe('readImageDimensions', () => {
  it('lee el tamaño de la cabecera IHDR de un PNG', () => {
    expect(readImageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('lee el tamaño del marcador SOF de un JPEG', () => {
    // FFD8 (SOI) + FFE0 con longitud 4 (relleno) + FFC0 con alto 600 y ancho 800.
    const buffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58,
      0x03, 0x20,
    ]);

    expect(readImageDimensions(buffer)).toEqual({ width: 800, height: 600 });
  });

  it('devuelve null cuando el formato no las expone en la cabecera', () => {
    // Es aceptable: las dimensiones sirven para maquetar sin saltos, no para ninguna regla.
    expect(readImageDimensions(heic())).toBeNull();
    expect(readImageDimensions(webp())).toBeNull();
  });

  it('no se cuelga con un JPEG cuyos segmentos declaran longitud cero', () => {
    // Un fichero corrupto —o hecho a mala fe— puede declarar longitudes que dejen el
    // puntero girando sin avanzar. El bucle está acotado y devuelve null.
    const buffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    expect(readImageDimensions(buffer)).toBeNull();
  });

  it('no lee fuera del búfer con un JPEG truncado tras el marcador', () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0]))).toBeNull();
  });
});
