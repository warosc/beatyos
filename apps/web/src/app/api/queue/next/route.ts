import { NextRequest } from 'next/server';
import { forwardToQueue } from '../forward';

export const POST = async (request: NextRequest) =>
  forwardToQueue('/next', 'POST', await request.text());
