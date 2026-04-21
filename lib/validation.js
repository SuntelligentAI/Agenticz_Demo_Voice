// Pure validation for the "start call" form. Used by the /api/calls/start
// handler. Client-side validation in public/assets/dashboard.js mirrors these
// rules for UX; the server is the authority.

export const START_CALL_RULES = {
  agentName: {
    min: 2,
    max: 40,
    pattern: /^[\p{L}\s'\-]+$/u,
    label: 'Agent name',
  },
  companyName: { min: 2, max: 80, label: 'Company name' },
  companyDescription: { min: 10, max: 400, label: 'Company description' },
  callPurpose: { min: 10, max: 400, label: 'Call purpose' },
  prospectName: { min: 2, max: 60, label: 'Prospect name' },
  prospectPhone: {
    pattern: /^\+[1-9]\d{7,14}$/,
    label: 'Prospect phone',
  },
};

const FIELD_ORDER = [
  'agentName',
  'companyName',
  'companyDescription',
  'callPurpose',
  'prospectName',
  'prospectPhone',
];

function coerce(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function containsHtml(value) {
  return /[<>]/.test(value);
}

export function validateStartCallInput(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid input', fieldErrors: {} };
  }

  const cleaned = {};
  for (const key of FIELD_ORDER) {
    cleaned[key] = coerce(input[key]);
  }

  const fieldErrors = {};

  for (const key of FIELD_ORDER) {
    const value = cleaned[key];
    const rule = START_CALL_RULES[key];

    if (containsHtml(value)) {
      fieldErrors[key] = `${rule.label} contains invalid characters.`;
      continue;
    }

    if (key === 'prospectPhone') {
      if (!value || !rule.pattern.test(value)) {
        fieldErrors[key] =
          'Use international format, e.g. +447700900000 (8–15 digits after +).';
      }
      continue;
    }

    if (!value) {
      fieldErrors[key] = `${rule.label} is required.`;
      continue;
    }
    if (value.length < rule.min) {
      fieldErrors[key] = `${rule.label} must be at least ${rule.min} characters.`;
      continue;
    }
    if (value.length > rule.max) {
      fieldErrors[key] = `${rule.label} must be at most ${rule.max} characters.`;
      continue;
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      fieldErrors[key] = `${rule.label} contains unsupported characters.`;
      continue;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Invalid input', fieldErrors };
  }

  return { ok: true, data: cleaned };
}
