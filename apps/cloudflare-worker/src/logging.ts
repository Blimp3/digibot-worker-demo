export type ErrorStage =
  | "workflow_setup"
  | "workflow_queue"
  | "cache_lookup"
  | "telegram_copy"
  | "container_prepare"
  | "prepared_result_persist"
  | "telegram_delivery"
  | "completion_persist"
  | "waiting_message_cleanup"
  | "failure_persist";

export type FailureReason = "application_error" | "workflow_wrapper" | "unexpected_error";

export type WorkflowErrorName =
  | "ApplicationError"
  | "WorkflowInternalError"
  | "AbortError"
  | "TypeError"
  | "Error"
  | "UnknownError";

export interface StructuredLogFields {
  jobId?: string;
  // Accepted for source compatibility with older call sites, but deliberately
  // never serialized: Telegram update identifiers are not operational log data.
  updateId?: string;
  sourceHost?: string;
  sourceUrlHash?: string;
  state?: string;
  operationMs?: number;
  outputSize?: number;
  errorCode?: string;
  retryCount?: number;
  telegramHttpStatus?: number;
  telegramApiErrorCode?: number;
  telegramRetryAfterSeconds?: number;
  errorStage?: ErrorStage;
  failureReason?: FailureReason;
  workflowAttempt?: number;
  workflowErrorName?: WorkflowErrorName;
  workflowErrorCodeRecovered?: boolean;
}

/** Emit only allowlisted operational fields; never pass a complete URL/token. */
export function logStructured(event: string, fields: StructuredLogFields = {}): void {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...(fields.jobId ? { job_id: fields.jobId } : {}),
    ...(fields.sourceHost ? { source_host: fields.sourceHost } : {}),
    ...(fields.sourceUrlHash ? { source_url_hash: fields.sourceUrlHash } : {}),
    ...(fields.state ? { state: fields.state } : {}),
    ...(typeof fields.operationMs === "number" ? { operation_ms: fields.operationMs } : {}),
    ...(typeof fields.outputSize === "number" ? { output_size: fields.outputSize } : {}),
    ...(fields.errorCode ? { error_code: fields.errorCode } : {}),
    ...(typeof fields.retryCount === "number" ? { retry_count: fields.retryCount } : {}),
    ...(typeof fields.telegramHttpStatus === "number" ? { telegram_http_status: fields.telegramHttpStatus } : {}),
    ...(typeof fields.telegramApiErrorCode === "number" ? { telegram_api_error_code: fields.telegramApiErrorCode } : {}),
    ...(typeof fields.telegramRetryAfterSeconds === "number" ? { telegram_retry_after_seconds: fields.telegramRetryAfterSeconds } : {}),
    ...(fields.errorStage ? { error_stage: fields.errorStage } : {}),
    ...(fields.failureReason ? { failure_reason: fields.failureReason } : {}),
    ...(typeof fields.workflowAttempt === "number" ? { workflow_attempt: fields.workflowAttempt } : {}),
    ...(fields.workflowErrorName ? { workflow_error_name: fields.workflowErrorName } : {}),
    ...(typeof fields.workflowErrorCodeRecovered === "boolean"
      ? { workflow_error_code_recovered: fields.workflowErrorCodeRecovered }
      : {}),
  };
  console.log(JSON.stringify(payload));
}
