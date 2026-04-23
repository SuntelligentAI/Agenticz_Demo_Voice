// Idempotent Retell setup for the Receptionist demo.
//
// First run:
//   - Creates a new Retell LLM with the receptionist prompt + begin message
//   - Creates a new Agent ("AGENTICZ_RECEPTIONIST_DO_NOT_EDIT") wired to
//     that LLM, with the call-event webhook and the dynamic-variables
//     webhook both pointed at our deployed app
//   - Binds the Canada phone number (RETELL_RECEPTIONIST_NUMBER) to the
//     new agent as its inbound agent
//   - Prints the IDs so the operator can paste them into .env and Vercel
//
// Subsequent runs (after IDs are in .env):
//   - Re-PATCHes the LLM prompt + begin message, in case we iterate
//   - Re-PATCHes the agent webhooks, in case the URLs change
//   - Re-binds the phone number, in case it was detached
//
// All Retell calls go via lib/retell.js, which never logs the API key.

import {
  createRetellLlm,
  updateRetellLlm,
  createAgent,
  updateAgent,
  updatePhoneNumber,
  getAgent,
} from '../lib/retell.js';
import { resolveReceptionistVoiceId } from '../lib/retell-setup.js';

const WEBHOOK_ORIGIN =
  process.env.RECEPTIONIST_WEBHOOK_ORIGIN || 'https://demo.agenticz.io';

const AGENT_NAME = 'AGENTICZ_RECEPTIONIST_DO_NOT_EDIT';

const BEGIN_MESSAGE = `Good morning, you've reached {{company_name}}, this is {{agent_name}} — how can I help you today?`;

const GENERAL_PROMPT = `You are {{agent_name}}, the receptionist for {{company_name}}.

ABOUT THE COMPANY
{{company_description}}

WHY YOU ARE ON THIS LINE
{{call_purpose}}

STYLE
- Warm, professional, concise. British English.
- Sound like a real person who works at the company, not a script.
- Never say you are an AI unless directly asked; if asked, be honest and brief.
- Never invent details about the company beyond what is in ABOUT THE COMPANY.

OBJECTIVE
Answer the inbound call. Understand why the caller has rung. If it's a lead, qualify them lightly and offer to book a follow-up. If it's an existing customer, take a message. If you cannot help, politely explain the receptionist's remit and offer a callback.

FLOW
1. Greet with the company name and ask who's calling and how you can help.
2. Listen to the reason for the call.
3. For leads: ask one or two light qualifying questions, then offer a callback slot (morning/afternoon, weekday/weekend, specific day/time). Confirm clearly. NOTE: No real calendar is connected. You are simulating the booking for a demo.
4. For customers: take their name, number, and reason, and promise a callback.
5. Always end with a warm, professional goodbye.

RULES
- Keep turns short, under 2 sentences where possible.
- If the caller is confused or silent, gently re-introduce yourself.
- Do not ask for payment details, full address, or sensitive data.
`;

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`${name} is not set`);
  }
  return v;
}

required('RETELL_API_KEY');
const phoneNumber = required('RETELL_RECEPTIONIST_NUMBER');

const existingLlmId = process.env.RETELL_RECEPTIONIST_LLM_ID || '';
const existingAgentId = process.env.RETELL_RECEPTIONIST_AGENT_ID || '';

const callWebhookUrl = `${WEBHOOK_ORIGIN}/api/webhooks/retell`;
const dynVarWebhookUrl = `${WEBHOOK_ORIGIN}/api/receptionist/context`;

let llmId = existingLlmId;
let agentId = existingAgentId;

// --- LLM -----------------------------------------------------------------

const llmBody = {
  general_prompt: GENERAL_PROMPT,
  begin_message: BEGIN_MESSAGE,
};

if (llmId) {
  console.log(`Updating existing Retell LLM ${llmId}…`);
  await updateRetellLlm(llmId, llmBody);
} else {
  console.log('Creating new Retell LLM…');
  const llm = await createRetellLlm(llmBody);
  llmId = llm?.llm_id || llm?.id;
  if (!llmId) {
    throw new Error(
      'create-retell-llm returned no llm_id: ' +
        JSON.stringify(llm).slice(0, 300),
    );
  }
  console.log(`Created LLM: ${llmId}`);
}

// --- Agent ---------------------------------------------------------------

const voiceId = await resolveReceptionistVoiceId({ getAgent });

// voice_id is written on every run so changes to Speed To Lead's voice
// propagate here — that's the whole point of the parity helper above.
const agentCommonFields = {
  agent_name: AGENT_NAME,
  response_engine: { type: 'retell-llm', llm_id: llmId },
  webhook_url: callWebhookUrl,
  // Retell documents this field as the agent's pre-call "dynamic variable"
  // webhook. If your Retell plan or API version uses a different field
  // name, update it here and in the dashboard to match.
  dynamic_variables_webhook_url: dynVarWebhookUrl,
  voice_id: voiceId,
};

if (agentId) {
  console.log(`Updating existing Retell agent ${agentId}…`);
  await updateAgent(agentId, agentCommonFields);
} else {
  console.log('Creating new Retell agent…');
  const agent = await createAgent(agentCommonFields);
  agentId = agent?.agent_id || agent?.id;
  if (!agentId) {
    throw new Error(
      'create-agent returned no agent_id: ' +
        JSON.stringify(agent).slice(0, 300),
    );
  }
  console.log(`Created agent: ${agentId}`);
}

// --- Phone number binding ------------------------------------------------

console.log(`Binding ${phoneNumber} to agent ${agentId} as inbound agent…`);
await updatePhoneNumber(phoneNumber, {
  inbound_agent_id: agentId,
});

console.log('');
console.log('Retell receptionist setup complete.');
console.log(`  Agent: ${agentId}`);
console.log(`  LLM:   ${llmId}`);
console.log(`  Number bound: ${phoneNumber}`);
console.log('');
if (!existingAgentId || !existingLlmId) {
  console.log(
    'NEXT: paste these into .env AND Vercel env vars (Production + Preview + Development):',
  );
  console.log(`  RETELL_RECEPTIONIST_AGENT_ID=${agentId}`);
  console.log(`  RETELL_RECEPTIONIST_LLM_ID=${llmId}`);
}
