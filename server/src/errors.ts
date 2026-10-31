export interface ErrorDetail {
  field?: string;
  message: string;
}

/** Expected application error that maps to the SPEC §12 error shape. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  validation: (details: ErrorDetail[]) =>
    new AppError(400, "VALIDATION_ERROR", "Input validation failed.", details),
  unauthenticated: (message = "Authentication required.") =>
    new AppError(401, "UNAUTHENTICATED", message),
  forbidden: (message = "You do not have permission to perform this action.") =>
    new AppError(403, "FORBIDDEN", message),
  notFound: (resource: string) => new AppError(404, "NOT_FOUND", `${resource} not found.`),
  conflict: (message: string) => new AppError(409, "CONFLICT", message),
  rateLimited: (message = "Too many attempts. Try again later.") =>
    new AppError(429, "RATE_LIMITED", message),
};
