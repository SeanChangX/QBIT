// ---------------------------------------------------------------------------
//  Request validation -- schemas and the validate() middleware keep the same
//  contract across Zod major versions (400 + { error, details[] })
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { validate, validateParams } from '../src/middleware/validate';
import {
  adminBanSchema,
  libraryBatchSchema,
  meSettingsSchema,
  pokeSchema,
  reportSchema,
  friendUserIdParamSchema,
} from '../src/schemas';
import type { ZodType } from 'zod';

const TOKEN = 'a'.repeat(24);

interface Result {
  status?: number;
  body?: { error: string; details: { path: string; message: string }[] };
  nextCalled: boolean;
  nextErr?: unknown;
  req: Request;
}

function run(
  mw: (req: Request, res: Response, next: NextFunction) => void,
  input: { body?: unknown; params?: Record<string, string> }
): Result {
  const out: Result = { nextCalled: false, req: { body: input.body, params: input.params ?? {} } as Request };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: Result['body']) {
      out.body = payload;
      return this;
    },
  } as unknown as Response;
  mw(out.req, res, (err?: unknown) => {
    out.nextCalled = true;
    out.nextErr = err;
  });
  return out;
}

const body = (schema: ZodType, b: unknown) => run(validate(schema), { body: b });

describe('validate()', () => {
  it('passes a valid body through and strips unknown keys', () => {
    const r = body(pokeSchema, { targetId: TOKEN, text: 'hi', extra: 'x' });
    assert.equal(r.nextCalled, true);
    assert.equal(r.nextErr, undefined);
    assert.deepEqual(r.req.body, { targetId: TOKEN, text: 'hi' });
  });

  it('rejects an invalid body with 400 and per-field details', () => {
    const r = body(pokeSchema, { targetId: 'nope', text: '' });
    assert.equal(r.nextCalled, false);
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, 'Validation failed');
    const paths = r.body?.details.map((d) => d.path).sort();
    assert.deepEqual(paths, ['targetId', 'targetId', 'text']);
    for (const d of r.body?.details ?? []) assert.equal(typeof d.message, 'string');
  });

  it('reports nested array paths with dot notation', () => {
    const r = body(libraryBatchSchema, { ids: ['ok-1', 'bad id'] });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body?.details.map((d) => d.path), ['ids.1']);
  });

  it('enforces array length limits (oversized batches are rejected)', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    assert.equal(body(libraryBatchSchema, { ids }).status, 400);
    assert.equal(body(libraryBatchSchema, { ids: [] }).status, 400);
  });

  it('keeps custom refine messages', () => {
    const r = body(meSettingsSchema, {});
    assert.equal(r.status, 400);
    assert.deepEqual(r.body?.details, [
      { path: '', message: 'At least one of onlyFriendsCanPoke or publicFriends is required' },
    ]);
    assert.equal(body(adminBanSchema, { ip: '203.0.113.9' }).nextCalled, true);
    assert.equal(body(adminBanSchema, {}).status, 400);
  });

  it('applies transforms before the piped check', () => {
    const ok = body(reportSchema, { reportedPublicUserId: TOKEN, description: '  spam  ' });
    assert.equal(ok.nextCalled, true);
    assert.equal((ok.req.body as { description: string }).description, 'spam');
    assert.equal(body(reportSchema, { reportedPublicUserId: TOKEN, description: '   ' }).status, 400);
  });

  it('forwards non-Zod errors to next()', () => {
    const boom = { parse: () => { throw new Error('boom'); } } as unknown as ZodType;
    const r = body(boom, {});
    assert.equal(r.nextCalled, true);
    assert.ok(r.nextErr instanceof Error);
  });
});

describe('validateParams()', () => {
  it('accepts a valid path parameter', () => {
    const r = run(validateParams(friendUserIdParamSchema), { params: { userId: TOKEN } });
    assert.equal(r.nextCalled, true);
  });

  it('rejects a malformed path parameter with 400', () => {
    const r = run(validateParams(friendUserIdParamSchema), { params: { userId: '../etc' } });
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, 'Invalid path parameter');
    assert.equal(r.body?.details[0].path, 'userId');
  });
});
