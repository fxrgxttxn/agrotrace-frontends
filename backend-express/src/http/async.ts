/** Express 4 does not await handlers: a rejected promise must reach the error handler (problem.ts) through next(). */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
