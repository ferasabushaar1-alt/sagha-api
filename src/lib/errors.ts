export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function badRequest(message: string, code?: string) {
  return new AppError(400, message, code);
}

export function unauthorized(message = "Unauthorized") {
  return new AppError(401, message, "UNAUTHORIZED");
}

export function forbidden(message = "Forbidden") {
  return new AppError(403, message, "FORBIDDEN");
}

export function notFound(message = "Not found") {
  return new AppError(404, message, "NOT_FOUND");
}

export function conflict(message: string) {
  return new AppError(409, message, "CONFLICT");
}

export function tooMany(message: string) {
  return new AppError(429, message, "RATE_LIMITED");
}
