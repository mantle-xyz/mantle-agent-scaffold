export interface MantleMcpErrorOptions {
  /** This error cannot be resolved by the agent alone — it must ask the user. */
  requiresUserInput?: boolean;
  /** A ready-made question the LLM should present to the user. */
  questionForUser?: string;
  /** Explicit "DO NOT …" instructions that block common LLM workarounds. */
  doNot?: string[];
  /** Whether the same call may succeed if retried (e.g. transient RPC failure). */
  retryable?: boolean;
  /** A finite set of valid values the user (or agent) can choose from. */
  availableOptions?: string[];
}

export class MantleMcpError extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly details: Record<string, unknown> | null;
  readonly requiresUserInput: boolean;
  readonly questionForUser: string | null;
  readonly doNot: string[];
  readonly retryable: boolean;
  readonly availableOptions: string[];

  constructor(
    code: string,
    message: string,
    suggestion: string,
    details: Record<string, unknown> | null = null,
    options?: MantleMcpErrorOptions
  ) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
    this.details = details;
    this.requiresUserInput = options?.requiresUserInput ?? false;
    this.questionForUser = options?.questionForUser ?? null;
    this.doNot = options?.doNot ?? [];
    this.retryable = options?.retryable ?? false;
    this.availableOptions = options?.availableOptions ?? [];
  }
}

export function toErrorPayload(error: unknown): {
  error: true;
  code: string;
  message: string;
  suggestion: string;
  details: Record<string, unknown> | null;
  requires_user_input: boolean;
  question_for_user: string | null;
  do_not: string[];
  retryable: boolean;
  available_options: string[];
} {
  if (error instanceof MantleMcpError) {
    return {
      error: true,
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      details: error.details,
      requires_user_input: error.requiresUserInput,
      question_for_user: error.questionForUser,
      do_not: error.doNot,
      retryable: error.retryable,
      available_options: error.availableOptions
    };
  }

  return {
    error: true,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    suggestion: "Retry the operation or check server logs.",
    details: null,
    requires_user_input: false,
    question_for_user: null,
    do_not: [],
    retryable: false,
    available_options: []
  };
}
