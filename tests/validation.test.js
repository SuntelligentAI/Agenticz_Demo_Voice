import { describe, it, expect } from 'vitest';
import { validateStartCallInput } from '../lib/validation.js';

const VALID = {
  agentName: 'Sarah',
  companyName: 'Acme Roofing',
  companyDescription: 'We install commercial flat roofs across the UK.',
  callPurpose: 'Follow up on their enquiry about a warehouse roof repair.',
  prospectName: 'John',
  prospectPhone: '+447700900000',
};

function withField(field, value) {
  return { ...VALID, [field]: value };
}

describe('validateStartCallInput — happy path', () => {
  it('accepts a fully valid payload', () => {
    const r = validateStartCallInput(VALID);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(VALID);
  });

  it('strips control chars and trims whitespace', () => {
    const dirty = {
      ...VALID,
      agentName: '  Sarah\u0000  ',
      companyName: '\u0001Acme Roofing\u0007',
    };
    const r = validateStartCallInput(dirty);
    expect(r.ok).toBe(true);
    expect(r.data.agentName).toBe('Sarah');
    expect(r.data.companyName).toBe('Acme Roofing');
  });

  it('accepts Unicode letters and hyphens/apostrophes in agent name', () => {
    for (const name of ["Jean-Luc", "O'Brien", 'Álvaro', 'Søren']) {
      const r = validateStartCallInput(withField('agentName', name));
      expect(r.ok, `expected ${name} to be accepted`).toBe(true);
    }
  });
});

describe('validateStartCallInput — rejections', () => {
  it('rejects non-object input', () => {
    expect(validateStartCallInput(null).ok).toBe(false);
    expect(validateStartCallInput('foo').ok).toBe(false);
    expect(validateStartCallInput(42).ok).toBe(false);
  });

  it('rejects HTML characters in any field with a generic server error', () => {
    const fields = [
      'agentName',
      'companyName',
      'companyDescription',
      'callPurpose',
      'prospectName',
    ];
    for (const f of fields) {
      const r = validateStartCallInput(withField(f, 'hello <script>evil'));
      expect(r.ok, `expected ${f} to reject <`).toBe(false);
      expect(r.error).toBe('Invalid input');
      expect(r.fieldErrors[f]).toMatch(/invalid characters/i);
    }
  });

  describe('agentName', () => {
    it('rejects under 2 chars', () => {
      const r = validateStartCallInput(withField('agentName', 'A'));
      expect(r.ok).toBe(false);
      expect(r.fieldErrors.agentName).toMatch(/at least 2/i);
    });
    it('rejects over 40 chars', () => {
      const r = validateStartCallInput(withField('agentName', 'A'.repeat(41)));
      expect(r.ok).toBe(false);
      expect(r.fieldErrors.agentName).toMatch(/at most 40/i);
    });
    it('rejects digits and punctuation other than apostrophe/hyphen', () => {
      const r = validateStartCallInput(withField('agentName', 'Sarah123'));
      expect(r.ok).toBe(false);
      expect(r.fieldErrors.agentName).toMatch(/unsupported/i);
    });
    it('accepts exactly 2 and 40 chars', () => {
      expect(validateStartCallInput(withField('agentName', 'Al')).ok).toBe(true);
      expect(
        validateStartCallInput(withField('agentName', 'A'.repeat(40))).ok,
      ).toBe(true);
    });
  });

  describe('companyName', () => {
    it('rejects under 2 chars', () => {
      expect(
        validateStartCallInput(withField('companyName', 'A')).ok,
      ).toBe(false);
    });
    it('rejects over 80 chars', () => {
      expect(
        validateStartCallInput(withField('companyName', 'A'.repeat(81))).ok,
      ).toBe(false);
    });
    it('accepts ampersands, digits, punctuation', () => {
      expect(
        validateStartCallInput(withField('companyName', "Acme & Co. 2025")).ok,
      ).toBe(true);
    });
  });

  describe('companyDescription', () => {
    it('rejects under 10 chars', () => {
      expect(
        validateStartCallInput(withField('companyDescription', 'short')).ok,
      ).toBe(false);
    });
    it('rejects over 400 chars', () => {
      expect(
        validateStartCallInput(
          withField('companyDescription', 'a'.repeat(401)),
        ).ok,
      ).toBe(false);
    });
  });

  describe('callPurpose', () => {
    it('rejects under 10 chars', () => {
      expect(validateStartCallInput(withField('callPurpose', 'hi')).ok).toBe(
        false,
      );
    });
    it('rejects over 400 chars', () => {
      expect(
        validateStartCallInput(withField('callPurpose', 'a'.repeat(401))).ok,
      ).toBe(false);
    });
  });

  describe('prospectName', () => {
    it('rejects under 2 chars', () => {
      expect(
        validateStartCallInput(withField('prospectName', 'A')).ok,
      ).toBe(false);
    });
    it('rejects over 60 chars', () => {
      expect(
        validateStartCallInput(withField('prospectName', 'A'.repeat(61))).ok,
      ).toBe(false);
    });
  });

  describe('prospectPhone', () => {
    it.each([
      '',
      '07700900000',
      '+0 7700900000',
      '+44',
      '+441',
      '+4412345678901234567890',
      '+01234567890',
      '447700900000',
      '+44 7700 900000',
    ])('rejects %s', (value) => {
      const r = validateStartCallInput(withField('prospectPhone', value));
      expect(r.ok, `expected ${JSON.stringify(value)} to be rejected`).toBe(
        false,
      );
      expect(r.fieldErrors.prospectPhone).toBeDefined();
    });

    it.each([
      '+447700900000',
      '+14155552671',
      '+12025550199',
      '+81312345678',
    ])('accepts %s', (value) => {
      const r = validateStartCallInput(withField('prospectPhone', value));
      expect(r.ok, `expected ${value} to be accepted`).toBe(true);
    });
  });
});
