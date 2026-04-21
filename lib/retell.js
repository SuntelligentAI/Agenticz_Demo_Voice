// Retell API client. Uses native fetch. Never logs the API key.
// Docs: https://docs.retellai.com/api-references/
//   - Calls: /v2/create-phone-call, /v2/get-call/:id
//   - Agents: /get-agent/:id
//   - Retell LLM: /update-retell-llm/:id

const BASE_URL = 'https://api.retellai.com';

function getApiKey() {
  const key = process.env.RETELL_API_KEY;
  if (!key) throw new Error('RETELL_API_KEY is not set');
  return key;
}

async function request(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const excerpt = text ? text.slice(0, 500) : '(empty body)';
    throw new Error(
      `Retell ${method} ${path} failed: ${res.status} ${res.statusText} — ${excerpt}`,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function createPhoneCall({
  fromNumber,
  toNumber,
  overrideAgentId,
  metadata,
  retellLlmDynamicVariables,
}) {
  if (!fromNumber) throw new Error('fromNumber is required');
  if (!toNumber) throw new Error('toNumber is required');

  const body = {
    from_number: fromNumber,
    to_number: toNumber,
  };
  if (overrideAgentId) body.override_agent_id = overrideAgentId;
  if (metadata) body.metadata = metadata;
  if (retellLlmDynamicVariables) {
    body.retell_llm_dynamic_variables = retellLlmDynamicVariables;
  }

  const response = await request('POST', '/v2/create-phone-call', body);
  const callId = response?.call_id;
  if (!callId) {
    throw new Error(
      `Retell create-phone-call returned no call_id: ${JSON.stringify(response).slice(0, 300)}`,
    );
  }
  return { callId };
}

export async function getCall(callId) {
  if (!callId) throw new Error('callId is required');
  return request('GET', `/v2/get-call/${encodeURIComponent(callId)}`);
}

export async function getAgent(agentId) {
  if (!agentId) throw new Error('agentId is required');
  return request('GET', `/get-agent/${encodeURIComponent(agentId)}`);
}

export async function updateRetellLlm(
  llmId,
  { general_prompt, begin_message } = {},
) {
  if (!llmId) throw new Error('llmId is required');
  const body = {};
  if (general_prompt !== undefined) body.general_prompt = general_prompt;
  if (begin_message !== undefined) body.begin_message = begin_message;
  if (Object.keys(body).length === 0) {
    throw new Error(
      'updateRetellLlm: must supply at least one of general_prompt or begin_message',
    );
  }
  return request(
    'PATCH',
    `/update-retell-llm/${encodeURIComponent(llmId)}`,
    body,
  );
}
