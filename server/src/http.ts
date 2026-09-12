import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Wrap async route handlers so thrown errors hit the error middleware. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Require fields to be present (not undefined/null) on the body. */
export function require_(body: any, fields: string[]) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`);
  }
}
