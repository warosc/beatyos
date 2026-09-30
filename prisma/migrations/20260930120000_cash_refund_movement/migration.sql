-- Anulación de ventas cobradas (ADR-0020): el efectivo devuelto sale de la caja abierta
-- como un movimiento propio, distinguible en el arqueo de un gasto o una retirada.
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'REFUND';
