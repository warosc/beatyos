import { NextRequest } from 'next/server';
import { forwardToQueue } from './forward';

export const GET = () => forwardToQueue('', 'GET');
export const POST = async (request: NextRequest) =>
  forwardToQueue('', 'POST', await request.text());
