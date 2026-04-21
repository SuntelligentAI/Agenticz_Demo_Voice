import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.RETELL_API_KEY = 'test-retell-key-SECRET-DO-NOT-LOG';

let retell;
beforeAll(async () => {
  retell = await import('../lib/retell.js');
});

function mockFetchResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  body = '',
}) {
  return {
    ok,
    status,
    statusText,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('retell client', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  describe('createPhoneCall', () => {
    it('formats the request body and returns { callId }', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({ body: { call_id: 'call_abc123' } }),
      );

      const result = await retell.createPhoneCall({
        fromNumber: '+447700900001',
        toNumber: '+447700900002',
        overrideAgentId: 'agent_xyz',
        metadata: { demo_call_id: 'd_42' },
        retellLlmDynamicVariables: {
          agent_name: 'Ava',
          company_name: 'Agenticz',
          company_description: 'We build voice agents.',
          call_purpose: 'Demo outbound call.',
          prospect_name: 'Alice',
        },
      });

      expect(result).toEqual({ callId: 'call_abc123' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.retellai.com/v2/create-phone-call');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe(
        'Bearer test-retell-key-SECRET-DO-NOT-LOG',
      );
      expect(opts.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        from_number: '+447700900001',
        to_number: '+447700900002',
        override_agent_id: 'agent_xyz',
        metadata: { demo_call_id: 'd_42' },
        retell_llm_dynamic_variables: {
          agent_name: 'Ava',
          company_name: 'Agenticz',
          company_description: 'We build voice agents.',
          call_purpose: 'Demo outbound call.',
          prospect_name: 'Alice',
        },
      });
    });

    it('omits optional fields when not provided', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({ body: { call_id: 'call_min' } }),
      );

      await retell.createPhoneCall({
        fromNumber: '+447700900001',
        toNumber: '+447700900002',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({
        from_number: '+447700900001',
        to_number: '+447700900002',
      });
      expect(body.override_agent_id).toBeUndefined();
      expect(body.metadata).toBeUndefined();
      expect(body.retell_llm_dynamic_variables).toBeUndefined();
    });

    it('throws when fromNumber or toNumber is missing', async () => {
      await expect(
        retell.createPhoneCall({ toNumber: '+447700900002' }),
      ).rejects.toThrow(/fromNumber/);
      await expect(
        retell.createPhoneCall({ fromNumber: '+447700900001' }),
      ).rejects.toThrow(/toNumber/);
    });

    it('throws on non-2xx with status and body excerpt', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          body: { error: 'invalid to_number' },
        }),
      );

      await expect(
        retell.createPhoneCall({
          fromNumber: '+447700900001',
          toNumber: 'not-a-number',
        }),
      ).rejects.toThrow(/422.*invalid to_number/);
    });

    it('throws when the response has no call_id', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse({ body: {} }));
      await expect(
        retell.createPhoneCall({
          fromNumber: '+447700900001',
          toNumber: '+447700900002',
        }),
      ).rejects.toThrow(/no call_id/);
    });
  });

  describe('getCall', () => {
    it('GETs /v2/get-call/:id and returns the full payload', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({
          body: { call_id: 'call_abc', call_status: 'ended', duration_ms: 9000 },
        }),
      );

      const call = await retell.getCall('call_abc');
      expect(call.call_status).toBe('ended');
      expect(call.duration_ms).toBe(9000);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.retellai.com/v2/get-call/call_abc');
      expect(opts.method).toBe('GET');
      expect(opts.body).toBeUndefined();
    });

    it('throws when callId is missing', async () => {
      await expect(retell.getCall()).rejects.toThrow(/callId/);
    });
  });

  describe('getAgent', () => {
    it('GETs /get-agent/:id', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({
          body: {
            agent_id: 'agent_xyz',
            response_engine: { type: 'retell-llm', llm_id: 'llm_123' },
          },
        }),
      );

      const agent = await retell.getAgent('agent_xyz');
      expect(agent.response_engine.llm_id).toBe('llm_123');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.retellai.com/get-agent/agent_xyz');
      expect(opts.method).toBe('GET');
    });
  });

  describe('updateRetellLlm', () => {
    it('PATCHes /update-retell-llm/:id with the supplied prompts', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse({ body: { ok: true } }));

      await retell.updateRetellLlm('llm_123', {
        general_prompt: 'you are x',
        begin_message: 'hi there',
      });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.retellai.com/update-retell-llm/llm_123');
      expect(opts.method).toBe('PATCH');
      expect(JSON.parse(opts.body)).toEqual({
        general_prompt: 'you are x',
        begin_message: 'hi there',
      });
    });

    it('throws when no prompt fields are supplied', async () => {
      await expect(retell.updateRetellLlm('llm_123', {})).rejects.toThrow(
        /at least one/,
      );
    });

    it('throws when llmId is missing', async () => {
      await expect(
        retell.updateRetellLlm(undefined, { general_prompt: 'x' }),
      ).rejects.toThrow(/llmId/);
    });
  });

  describe('security', () => {
    it('does not include the API key in error messages', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({
          ok: false,
          status: 500,
          statusText: 'Server Error',
          body: 'internal',
        }),
      );
      try {
        await retell.getCall('call_x');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).not.toContain('test-retell-key-SECRET-DO-NOT-LOG');
        expect(err.message).not.toContain('Bearer');
      }
    });
  });
});
