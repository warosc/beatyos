import { NextRequest } from 'next/server';
import { forwardToQueue } from '../forward';

export const GET = (request: NextRequest) =>
  forwardToQueue(`/stats${request.nextUrl.search}`, 'GET');
