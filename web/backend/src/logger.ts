// ---------------------------------------------------------------------------
//  Structured logger (pino)
// ---------------------------------------------------------------------------

import pino from 'pino';
import { NODE_ENV } from './config';

const isDev = NODE_ENV === 'development';

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

export default logger;
