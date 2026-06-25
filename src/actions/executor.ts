import type { AppConfig } from '../config/schema.js';
import type { TodoAiActionRecord } from './todo-actions.js';

export type TodoAiActionExecutorType = 'none' | 'webhook';
export type TodoAiActionExecutionStatus = 'skipped' | 'accepted' | 'failed';

export interface TodoAiActionExecutionRequest {
  schema_version: 'daily-os.ai_action.v1';
  source: {
    app: 'daily-os-feishu';
    action_id: string;
    message_id?: string;
    created_at: string;
  };
  action: {
    id: string;
    todo_id: string;
    todo_text: string;
    kind: string;
    provider: string;
    title: string;
    draft: string;
  };
  execution: {
    mode: 'draft_handoff';
    require_user_confirmation: true;
    dry_run: boolean;
  };
  constraints: {
    no_external_writes_without_confirmation: true;
    preserve_audit_trail: true;
    return_result_summary: true;
  };
}

export interface TodoAiActionExecutionResult {
  status: TodoAiActionExecutionStatus;
  executor: TodoAiActionExecutorType;
  request: TodoAiActionExecutionRequest;
  reason?: string;
  response_status?: number;
  response_body?: string;
  error?: string;
}

export function buildTodoAiActionExecutionRequest(config: AppConfig, action: TodoAiActionRecord): TodoAiActionExecutionRequest {
  return {
    schema_version: 'daily-os.ai_action.v1',
    source: {
      app: 'daily-os-feishu',
      action_id: action.id,
      ...(action.message_id ? { message_id: action.message_id } : {}),
      created_at: new Date().toISOString(),
    },
    action: {
      id: action.id,
      todo_id: action.todo_id,
      todo_text: action.todo_text,
      kind: action.kind,
      provider: action.provider,
      title: action.title,
      draft: action.draft,
    },
    execution: {
      mode: 'draft_handoff',
      require_user_confirmation: true,
      dry_run: config.ai_actions.dry_run,
    },
    constraints: {
      no_external_writes_without_confirmation: true,
      preserve_audit_trail: true,
      return_result_summary: true,
    },
  };
}

export async function executeTodoAiAction(config: AppConfig, action: TodoAiActionRecord): Promise<TodoAiActionExecutionResult> {
  const request = buildTodoAiActionExecutionRequest(config, action);
  const executor = config.ai_actions.executor;
  if (config.ai_actions.dry_run) {
    return { status: 'skipped', executor: executor.type, request, reason: 'ai_actions.dry_run=true' };
  }
  if (!executor.enabled || executor.type === 'none') {
    return { status: 'skipped', executor: executor.type, request, reason: 'ai_actions.executor is disabled' };
  }
  if (executor.type === 'webhook') return executeWebhook(config, request);
  return { status: 'failed', executor: executor.type, request, error: `Unsupported executor: ${executor.type}` };
}

async function executeWebhook(config: AppConfig, request: TodoAiActionExecutionRequest): Promise<TodoAiActionExecutionResult> {
  const executor = config.ai_actions.executor;
  if (!executor.endpoint_url.trim()) {
    return { status: 'failed', executor: 'webhook', request, error: 'ai_actions.executor.endpoint_url is empty' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), executor.timeout_ms);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-daily-os-action-id': request.action.id,
      'x-daily-os-schema-version': request.schema_version,
    };
    const token = executor.api_key_env ? process.env[executor.api_key_env] : '';
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(executor.endpoint_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    return {
      status: response.ok ? 'accepted' : 'failed',
      executor: 'webhook',
      request,
      response_status: response.status,
      response_body: responseBody.slice(0, 4000),
      ...(response.ok ? {} : { error: `Webhook returned HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      status: 'failed',
      executor: 'webhook',
      request,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
