import { Hono } from 'hono';
import { jsonError } from '../utils';

/** 跨端同步（占位，后续 Prompt 实现） */
export const syncRoutes = new Hono();

syncRoutes.all('/*', (c) => jsonError(c, 501, 'Sync API not implemented yet', 'not_implemented'));
