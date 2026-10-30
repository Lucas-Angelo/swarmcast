import { z } from 'zod';

/**
 * zod without its JIT. On the first object schema, zod 4 checks whether it may compile parsers
 * with `new Function`. The viewer and panel CSPs (script-src 'self', no 'unsafe-eval') refuse
 * that, and although zod catches the error, Firefox still reports a CSP violation on every page
 * load. jitless skips the check and the compiled fast path; our payloads are small, so the plain
 * parser costs nothing noticeable. Imported first by every module that builds schemas, so it runs
 * before the first z.object().
 */
z.config({ jitless: true });
