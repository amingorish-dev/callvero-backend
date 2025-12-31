export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function assertOrThrow(condition: unknown, status: number, message: string, details?: unknown): void {
  if (!condition) {
    throw new ApiError(status, message, details);
  }
}
