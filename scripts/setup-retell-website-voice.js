// Idempotent Retell setup for the Website Voice Bot demo.
//
// First run:
//   - Creates a new Retell LLM with the website-voice prompt + begin message
//   - Creates a new Agent ("AGENTICZ_WEBSITE_VOICE_DO_NOT_EDIT") wired to
//     that LLM, with the call-event webhook URL set to our deployed app
//   - voice_id matches Speed To Lead (read live via resolveReceptionistVoiceId,
//     which is actually "resolve from SToL" — we reuse the same helper)
//   - No phone number is bound: this agent runs over Retell's Web Call API
//   - Prints the IDs so the operator can paste them into .env and Vercel
//
// Subsequent runs:
//   - Re-PATCHes the LLM prompt + begin message + agent webhook + voice_id
//
// Never logs the API key.

import {
  createRetellLlm,
  updateRetellLlm,
  createAgent,
  updateAgent,
  getAgent,
} from '../lib/retell.js';
import { resolveReceptionistVoiceId } from '../lib/retell-setup.js';

const WEBHOOK_ORIGIN =
  process.env.WEBSITE_VOICE_WEBHOOK_ORIGIN || 'https://demo.agenticz.io';

const AGENT_NAME = 'AGENTICZ_WEBSITE_VOICE_DO_NOT_EDIT';

const BEGIN_MESSAGE = `Hi, I'm {{agent_name}}. How can I help?`;

const GENERAL_PROMPT = `You are {{agent_name}}, speaking on behalf of {{company_name}} through the website's voice widget.

ABOUT THE COMPANY
{{company_description}}

WHY YOU ARE ON THIS WIDGET
{{call_purpose}}

STYLE
- Warm, professional, concise. British English.
- Short turns, under 2 sentences where possible.
- Sound like a real person working at the company, not a script.
- Never say you are an AI unless directly asked; if asked, be honest and brief.
- Never invent details beyond ABOUT THE COMPANY.

OBJECTIVE
Answer the visitor's questions. If the visitor wants to speak with a human or book a meeting, offer to take them through a quick booking flow.

FLOW
1. Open with: "Hi, I'm {{agent_name}} — how can I help today?"
2. Listen to the visitor. Answer from ABOUT THE COMPANY.
3. If unsure, say so honestly and offer to connect them with someone.
4. If the visitor wants a meeting: ask when they're free (morning/afternoon, weekday/weekend, a specific day or time). Propose a specific slot. Confirm the slot clearly.
5. After confirming the slot, say: "Brilliant — I'll get that booked in for you now. Check the booking confirmation on screen and you're all set."
6. End warmly.

DEMO NOTE (internal)
This is a demo. There is no calendar connected. You are simulating the booking — speak as though it's happening. The screen will show a real booking interface after you confirm, where the visitor completes the booking themselves.

RULES
- Keep turns short.
- If the visitor is confused or silent, gently re-introduce yourself.
- Do not ask for payment details or sensitive data.
`;

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`${name} is not set`);
  }
  return v;
}

required('RETELL_API_KEY');

const existingLlmId = process.env.RETELL_WEBSITE_VOICE_LLM_ID || '';
const existingAgentId = process.env.RETELL_WEBSITE_VOICE_AGENT_ID || '';

const callWebhookUrl = `${WEBHOOK_ORIGIN}/api/webhooks/retell`;

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

const agentCommonFields = {
  agent_name: AGENT_NAME,
  response_engine: { type: 'retell-llm', llm_id: llmId },
  webhook_url: callWebhookUrl,
  voice_id: voiceId,
  // No dynamic_variables_webhook_url — for web calls we pass the variables
  // in the /v2/create-web-call request body directly.
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

console.log('');
console.log('Retell website-voice setup complete.');
console.log(`  Agent:   ${agentId}`);
console.log(`  LLM:     ${llmId}`);
console.log(`  Voice:   ${voiceId}  (parity with Speed To Lead)`);
console.log(`  Web call: uses /v2/create-web-call (no phone number needed)`);
console.log('');
if (!existingAgentId || !existingLlmId) {
  console.log(
    'NEXT: paste these into .env AND Vercel env vars (Production + Preview + Development):',
  );
  console.log(`  RETELL_WEBSITE_VOICE_AGENT_ID=${agentId}`);
  console.log(`  RETELL_WEBSITE_VOICE_LLM_ID=${llmId}`);
}
