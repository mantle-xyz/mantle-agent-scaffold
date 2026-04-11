export class MantleMcpError extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly details: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    suggestion: string,
    details: Record<string, unknown> | null = null
  ) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
    this.details = details;
  }
}

export function toErrorPayload(error: unknown): {
  error: true;
  code: string;
  message: string;
  suggestion: string;
  details: Record<string, unknown> | null;
} {
  if (error instanceof MantleMcpError) {
    return {
      error: true,
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      details: error.details
    };
  }

  return {
    error: true,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    suggestion: "Retry the operation or check server logs.",
    details: null
  };
}
