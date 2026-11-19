import type { AccountDocument } from '../models/account.model.js';
import type { MatchDocument } from '../models/match.model.js';
import type { OperatorSession } from '@skoriva/shared';

declare global {
  namespace Express {
    interface Request {
      account?: AccountDocument;
      /** Attached by operator-session or viewer-access middleware. */
      match?: MatchDocument;
      /** Attached by operator-session middleware (R-01). */
      operatorSession?: OperatorSession;
    }
  }
}

export {};
