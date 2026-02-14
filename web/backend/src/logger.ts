// ---------------------------------------------------------------------------
//  Structured logger (pino)
// ---------------------------------------------------------------------------

import pino from 'pino';
import { NODE_ENV } from './config';

const isDev = NODE_ENV === 'development';

// Check if pino-pretty is available (it is a devDependency and may not be
// installed in production / Docker runtime images).
let hasPinoPretty = false;
if (isDev) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('pino-pretty');
    hasPinoPretty = true;
  } catch {
    // pino-pretty not installed -- use plain JSON output
  }
}

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  serializers: {
    req: (req) => {
      // SanitizeHeaders: remove sensitive fields before logging
      const headers = { ...req.headers };
      if (headers.authorization) delete headers.authorization;
      if (headers['x-device-api-key']) delete headers['x-device-api-key'];
      return {
        method: req.method,
        url: req.url,
        headers: headers,
      };
    },
  },
  ...(hasPinoPretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

export default logger;
