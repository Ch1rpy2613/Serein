import { Hono } from 'hono';
import { jsonError } from '../utils';

/** Web Push 订阅（占位，后续 Prompt 实现） */
export const pushRoutes = new Hono();

pushRoutes.all('/*', (c) => jsonError(c, 501, 'Push API not implemented yet', 'not_implemented'));
