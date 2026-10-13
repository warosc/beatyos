# ADR-0026: Voz de los llamados: la del navegador, elegida y gratis

- **Estado:** Aceptado
- **Fecha:** 2026-10-13
- **Depende de:** [ADR-0024](0024-fila-de-espera-y-pantalla-de-turnos.md)

## Contexto

La pantalla de la sala anunciaba los llamados con la primera voz en español que daba el
navegador. En el aparato del salón resultó ser una voz de hombre y muy robótica. La
propietaria pidió una voz de mujer, lo más real posible, y **sin pagar ningún servicio**.

## Decisión

### 1. Voz del navegador, sin servicios externos

Se sigue usando `speechSynthesis`, la voz del aparato que mueve la TV: no cuesta nada y no
añade infraestructura. Se descartaron las voces neuronales en la nube (Azure, Google): aun con
capa gratuita exigen una cuenta y una clave de un tercero, y la propietaria no quiere
depender de un servicio que pueda cobrar.

### 2. Elegir la mejor voz automáticamente

`rankVoices` (web) ordena las voces en español del aparato:

| Criterio | Por qué |
| -------- | ------- |
| Neuronales primero («Natural», «Neural», «Online»; las de Google; las «mejoradas» de Apple) | Son las que suenan a persona |
| Acento: Guatemala, México, EE. UU., el resto de Latinoamérica, España | Lo más cercano a la clientela |
| Femenina por su nombre; las masculinas conocidas, al final | El navegador no dice el género |

En **Microsoft Edge** sobre Windows, la elegida es «Marta (Natural)» de Guatemala: la misma
tecnología neuronal que la voz de pago de Azure, gratis desde el navegador.

### 3. Escoger y probar a mano

El botón **Voz** de la pantalla lista las voces del aparato, con la recomendada primero y un
«Probar» en cada una. La elección se guarda en el propio aparato (`localStorage`): cada TV
tiene sus voces.

### 4. Una frase más humana

«Turno 7. Ana, por favor pase con Valeria.»: por el primer nombre (la API lo da como
`spokenName`; «Ana G.» se leería «Ana ge punto»), con un ritmo algo más pausado y un tono un
punto más alto, que se entienden mejor con secadores encendidos.

## Consecuencias

- La calidad depende del aparato. Con Edge en una computadora es excelente; con Chrome, la voz
  de Google es aceptable; el navegador de algunos Smart TV trae voces pobres o ninguna, y
  entonces solo suena la campanita. La pantalla lo dice y recomienda Edge.
- Si algún día el aparato no basta, la alternativa gratis es una voz libre en la VPS (Piper),
  con un contenedor pequeño: suena igual en cualquier TV, aunque menos natural que las de
  Microsoft. No se hace hasta que haga falta.

## Alternativas descartadas

- **Voz neuronal en la nube (Azure «Marta», Google Chirp).** La más real en cualquier aparato,
  pero exige cuenta y clave de un tercero; la propietaria no quiere servicios de pago.
- **Piper en la VPS ahora mismo.** Gratis, pero suma un contenedor y su voz femenina en
  español tiene acento argentino y suena menos natural que Marta en Edge. Queda como plan B.
