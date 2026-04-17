export class MantleMcpError extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly details: Record<string, unknown> | null;
  readonly requiresUserInput: boolean;
  readonly questionForUser: string | null;
  readonly doNot: string[];
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    suggestion: string,
    details: Record<string, unknown> | null = null,
    options?: {
      requiresUserInput?: boolean;
      questionForUser?: string;
      doNot?: string[];
      retryable?: boolean;
    }
  ) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
    this.details = details;
    this.requiresUserInput = options?.requiresUserInput ?? false;
    this.questionForUser = options?.questionForUser ?? null;
    this.doNot = options?.doNot ?? [];
    this.retryable = options?.retryable ?? false;
  }
}

export interface ErrorPayload {
  error: true;
  code: string;
  message: string;
  suggestion: string;
  details: Record<string, unknown> | null;
  requires_user_input: boolean;
  retryable: boolean;
  question_for_user?: string;
  do_not?: string[];
  available_options?: unknown[];
  _stop_instruction?: string;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  const payload = buildPayload(error);

  // Prepend a machine-readable stop instruction as the very first field so the
  // model reads it before parsing any other field (field-ordering matters for
  // LLM attention).  Text position beats JSON key ordering for most models, so
  // callers in MCP / CLI should also prepend this line to the serialised text.
  if (payload.requires_user_input) {
    payload._stop_instruction =
      "\uD83D\uDED1 STOP \u2014 This error requires user input. Do NOT proceed. " +
      "Present the question_for_user field to the user and wait for their response.";
  } else if (!payload.retryable) {
    payload._stop_instruction =
      "\u26A0\uFE0F ERROR \u2014 This operation failed and cannot be retried with the same " +
      "parameters. Check the suggestion field for next steps.";
  }

  return payload;
}

function buildPayload(error: unknown): ErrorPayload {
  if (error instanceof MantleMcpError) {
    const base: ErrorPayload = {
      error: true,
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      details: error.details,
      requires_user_input: error.requiresUserInput,
      retryable: error.retryable
    };

    if (error.questionForUser !== null) {
      base.question_for_user = error.questionForUser;
    }

    if (error.doNot.length > 0) {
      base.do_not = error.doNot;
    }

    // Promote available_options from details to top-level for easier LLM access
    if (
      error.details &&
      "available_options" in error.details &&
      Array.isArray(error.details.available_options)
    ) {
      base.available_options = error.details.available_options;
    }

    return base;
  }

  return {
    error: true,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    suggestion: "Retry the operation or check server logs.",
    details: null,
    requires_user_input: false,
    retryable: false
  };
}
