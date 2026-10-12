import { NextRequest, NextResponse } from 'next/server';
import { forwardToQueue } from '../../forward';

/** Lo que se puede hacer con un turno. Cualquier otra cosa ni se reenvía. */
const ACTIONS = new Set(['call', 'recall', 'start', 'no-show', 'requeue', 'cancel', 'finish']);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await context.params;
  if (!ACTIONS.has(action))
    return NextResponse.json({ message: 'Acción inválida.' }, { status: 400 });
  return forwardToQueue(`/${encodeURIComponent(id)}/${action}`, 'POST', await request.text());
}
