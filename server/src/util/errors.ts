export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'SESSION_REVOKED'
  | 'FORBIDDEN'
  | 'CSRF_INVALID'
  | 'ORIGIN_DENIED'
  | 'SELF_REVIEW_FORBIDDEN'
  | 'FORBIDDEN_FIELD'
  | 'NOT_FOUND'
  | 'ENTITY_VERSION_CONFLICT'
  | 'FIELD_VERSION_CONFLICT'
  | 'SUBMISSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'SCHEMA_MISMATCH'
  | 'VALIDATION_ERROR'
  | 'INVALID_TRANSITION'
  | 'COMPLETION_REQUIRED'
  | 'WORK_ITEM_BLOCKED'
  | 'ASSIGNEE_INELIGIBLE'
  | 'INVALID_CURSOR'
  | 'RESTRICTION_ACTIVE'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE';

const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  ORIGIN_DENIED: 403,
  SELF_REVIEW_FORBIDDEN: 403,
  FORBIDDEN_FIELD: 403,
  NOT_FOUND: 404,
  ENTITY_VERSION_CONFLICT: 409,
  FIELD_VERSION_CONFLICT: 409,
  SUBMISSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  SCHEMA_MISMATCH: 409,
  VALIDATION_ERROR: 422,
  INVALID_TRANSITION: 422,
  COMPLETION_REQUIRED: 422,
  WORK_ITEM_BLOCKED: 422,
  ASSIGNEE_INELIGIBLE: 422,
  INVALID_CURSOR: 422,
  RESTRICTION_ACTIVE: 423,
  RATE_LIMITED: 429,
  TEMPORARILY_UNAVAILABLE: 503,
};

export interface ErrorDetails {
  current_entity_version?: number;
  current_submission_id?: string | null;
  current_submission_revision?: number;
  current_status?: string;
  conflicts?: unknown[];
  issues?: { path: string; issue: string }[];
  retry_after_seconds?: number;
}

export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function errorBody(err: ApiError, requestId: string) {
  return {
    code: err.code,
    message: err.message,
    request_id: requestId,
    details: err.details ?? {},
  };
}
