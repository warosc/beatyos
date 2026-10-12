import { forwardToQueue } from '../forward';

export const GET = () => forwardToQueue('/display-link', 'GET');
export const POST = () => forwardToQueue('/display-link', 'POST');
