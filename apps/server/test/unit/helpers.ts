import pino from 'pino';

export const silentLog = pino({ level: 'silent' });
