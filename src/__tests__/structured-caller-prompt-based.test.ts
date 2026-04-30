import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunAgent } = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: mockRunAgent,
}));

import { PromptBasedStructuredCaller } from '../agents/structured-caller.js';
import { resolveStructuredStep } from '../agents/structured-caller/shared.js';

describe('PromptBasedStructuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should evaluate conditions from [JUDGE:N] tags without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:6]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.evaluateCondition(
      'agent output',
      [
        { index: 2, text: 'approved' },
        { index: 5, text: 'needs_fix' },
      ],
      { cwd: '/tmp/project', provider: 'cursor' },
    );

    expect(result).toBe(5);
    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('Output ONLY the tag `[JUDGE:N]`'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
      }),
    );
  });

  it('should pass resolvedProvider and resolvedModel through evaluateCondition to runAgent (#556)', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.evaluateCondition(
      'agent output',
      [{ index: 0, text: 'approved' }],
      {
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('[JUDGE:N]'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should parse decomposed parts from fenced JSON without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
          { id: 'p2', title: 'Second task', instruction: 'Do the second thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      model: 'cursor-fast',
      persona: 'team-leader',
      personaPath: '/tmp/personas/team-leader.md',
    });

    expect(result).toEqual([
      { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
      { id: 'p2', title: 'Second task', instruction: 'Do the second thing' },
    ]);
    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
        model: 'cursor-fast',
        personaPath: '/tmp/personas/team-leader.md',
        maxTurns: 5,
      }),
    );
    const [, , runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('should pass resolvedProvider and resolvedModel through decomposeTask to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'claude',
      resolvedProvider: 'cursor',
      model: 'sonnet',
      resolvedModel: 'cursor-fast',
      persona: 'team-leader',
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'cursor',
        model: 'sonnet',
        resolvedModel: 'cursor-fast',
      }),
    );
  });

  it('should pass workflowMeta through decomposeTask to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });
    const workflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: {
        protectedParentRunPid: 4242,
      },
    };

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'claude',
      persona: 'team-leader',
      workflowMeta,
    } as Parameters<PromptBasedStructuredCaller['decomposeTask']>[2] & { workflowMeta: typeof workflowMeta });

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({
        cwd: '/tmp/project',
        workflowMeta,
      }),
    );
  });

  it('should parse additional parts from fenced JSON without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({
          done: false,
          reasoning: 'Need one more pass',
          parts: [
            { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
          ],
        }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'Need one more pass',
      parts: [
        { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
      ],
    });
    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
      }),
    );
  });

  it('should pass resolvedProvider and resolvedModel through requestMoreParts to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'cursor',
        model: 'sonnet',
        resolvedModel: 'cursor-fast',
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'cursor',
        model: 'sonnet',
        resolvedModel: 'cursor-fast',
      }),
    );
  });

  it('should pass workflowMeta through requestMoreParts to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });
    const workflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: {
        protectedParentRunPid: 4242,
      },
    };

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        persona: 'team-leader',
        workflowMeta,
      } as Parameters<PromptBasedStructuredCaller['requestMoreParts']>[4] & { workflowMeta: typeof workflowMeta },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({
        cwd: '/tmp/project',
        workflowMeta,
      }),
    );
  });

  it('should return auto_select without calling agent when only one rule exists', async () => {
    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [{ condition: 'approved', next: 'done' }],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ ruleIndex: 0, method: 'auto_select' });
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('should return structured_output when Stage 1 JSON step is valid', async () => {
    mockRunAgent.mockResolvedValueOnce({
      persona: 'conductor',
      status: 'done',
      content: '```json\n{"step": 2}\n```',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      {
        cwd: '/tmp/project',
        stepName: 'review',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      },
    );

    expect(result).toEqual({ ruleIndex: 1, method: 'structured_output' });
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenNthCalledWith(
      1,
      'conductor',
      expect.stringContaining('structured instruction'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should return phase3_tag when Stage 1 fails and Stage 2 tag matches', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '[REVIEW:1]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ ruleIndex: 0, method: 'phase3_tag' });
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('should return ai_judge when Stage 1 and Stage 2 fail and evaluateCondition succeeds', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:2]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ ruleIndex: 1, method: 'ai_judge' });
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it('should exclude interactiveOnly rules from Stage 3 conditions when interactive is false', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:1]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'interactive-only-rule', next: 'blocked', interactiveOnly: true },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor', interactive: false },
    );

    // interactiveOnly rule (index 1) is excluded; only index 0 is passed to evaluateCondition
    // [JUDGE:1] → 0-based index 0, which maps to original index 0
    expect(result).toEqual({ ruleIndex: 0, method: 'ai_judge' });
    const [, judgePrompt] = mockRunAgent.mock.calls[2] ?? [];
    expect(judgePrompt).not.toContain('interactive-only-rule');
  });

  it('should include interactiveOnly rules in Stage 3 conditions when interactive is true', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:2]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'interactive-only-rule', next: 'blocked', interactiveOnly: true },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor', interactive: true },
    );

    // interactiveOnly rule (index 1) is included; [JUDGE:2] → 0-based index 1, which maps to original index 1
    expect(result).toEqual({ ruleIndex: 1, method: 'ai_judge' });
    const [, judgePrompt] = mockRunAgent.mock.calls[2] ?? [];
    expect(judgePrompt).toContain('interactive-only-rule');
  });

  it('should surface JSON parse failures when no fallback can determine status', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '```json\n{"step": }\n```',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no judge tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: 'no judge tag',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();

    await expect(caller.judgeStatus(
      'structured',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    )).rejects.toThrow('Structured response parsing failed');
  });

  describe('decomposeTask retry', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const successContent = [
      '```json',
      JSON.stringify([{ id: 'p1', title: 'First task', instruction: 'Do the first thing' }]),
      '```',
    ].join('\n');

    const successResponse = {
      persona: 'leader' as const,
      status: 'done' as const,
      content: successContent,
      timestamp: new Date(),
    };

    it('should succeed on second attempt when first attempt returns error status', async () => {
      // Given: first call returns error status, second call returns success
      mockRunAgent
        .mockResolvedValueOnce({
          persona: 'leader',
          status: 'error',
          content: 'LLM transient error',
          timestamp: new Date(),
        })
        .mockResolvedValueOnce(successResponse);

      vi.useFakeTimers();
      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called
      const promise = caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      // Then: returns parsed parts from second attempt
      expect(result).toEqual([{ id: 'p1', title: 'First task', instruction: 'Do the first thing' }]);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
    });

    it('should succeed on second attempt when first attempt has no JSON block', async () => {
      // Given: first call returns done status but no JSON block (parseParts throws)
      mockRunAgent
        .mockResolvedValueOnce({
          persona: 'leader',
          status: 'done',
          content: 'Here is the decomposition plan (but no json block)',
          timestamp: new Date(),
        })
        .mockResolvedValueOnce(successResponse);

      vi.useFakeTimers();
      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called
      const promise = caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      // Then: returns parsed parts from second attempt
      expect(result).toEqual([{ id: 'p1', title: 'First task', instruction: 'Do the first thing' }]);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
    });

    it('should succeed on second attempt when first attempt has malformed JSON', async () => {
      // Given: first call returns done status but malformed JSON (parseParts throws)
      mockRunAgent
        .mockResolvedValueOnce({
          persona: 'leader',
          status: 'done',
          content: '```json\n{not valid json}\n```',
          timestamp: new Date(),
        })
        .mockResolvedValueOnce(successResponse);

      vi.useFakeTimers();
      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called
      const promise = caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      // Then: returns parsed parts from second attempt
      expect(result).toEqual([{ id: 'p1', title: 'First task', instruction: 'Do the first thing' }]);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
    });

    it('should throw after all 3 attempts fail with error status', async () => {
      // Given: all 3 attempts return error status
      mockRunAgent.mockResolvedValue({
        persona: 'leader',
        status: 'error',
        content: 'persistent LLM error',
        timestamp: new Date(),
      });

      vi.useFakeTimers();
      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called — run timers and await rejection
      const promise = caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow('Team leader failed after 3 attempts: persistent LLM error');
      expect(mockRunAgent).toHaveBeenCalledTimes(3);
    });

    it('should throw after all 3 attempts fail with parse error', async () => {
      // Given: all 3 attempts return done but without valid JSON block
      mockRunAgent.mockResolvedValue({
        persona: 'leader',
        status: 'done',
        content: 'no json block at all',
        timestamp: new Date(),
      });

      vi.useFakeTimers();
      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called — run timers and await rejection
      const promise = caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow('Team leader failed after 3 attempts');
      expect(mockRunAgent).toHaveBeenCalledTimes(3);
    });

    it('should succeed on first attempt without any retry (no extra runAgent calls)', async () => {
      // Given: first call succeeds
      mockRunAgent.mockResolvedValueOnce(successResponse);

      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called
      const result = await caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });

      // Then: returns parsed parts and runAgent was called exactly once
      expect(result).toEqual([{ id: 'p1', title: 'First task', instruction: 'Do the first thing' }]);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });

    it('should wait DECOMPOSE_RETRY_DELAY_MS (1000ms) between attempts', async () => {
      // Given: first call returns error status, second call succeeds
      mockRunAgent
        .mockResolvedValueOnce({
          persona: 'leader',
          status: 'error',
          content: 'LLM transient error',
          timestamp: new Date(),
        })
        .mockResolvedValueOnce(successResponse);

      vi.useFakeTimers();
      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called
      const promise = caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });

      // Then: before delay passes, only 1 call has been made
      await vi.advanceTimersByTimeAsync(999);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      // After delay passes, second call is made
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;

      expect(result).toEqual([{ id: 'p1', title: 'First task', instruction: 'Do the first thing' }]);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
    });

    it('should include the last error message in the final throw', async () => {
      // Given: all attempts fail with distinct error messages
      mockRunAgent
        .mockResolvedValueOnce({
          persona: 'leader',
          status: 'error',
          content: 'first error',
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          persona: 'leader',
          status: 'error',
          content: 'second error',
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          persona: 'leader',
          status: 'error',
          content: 'last error message',
          timestamp: new Date(),
        });

      vi.useFakeTimers();
      const caller = new PromptBasedStructuredCaller();

      // When: decomposeTask is called — run timers and await rejection
      const promise = caller.decomposeTask('break down the work', 3, {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
      });
      await vi.runAllTimersAsync();

      // Then: the error message contains the last failure detail
      await expect(promise).rejects.toThrow('last error message');
      expect(mockRunAgent).toHaveBeenCalledTimes(3);
    });
  });
});

describe('resolveStructuredStep', () => {
  it('should convert 1-indexed step to 0-based rule index', () => {
    expect(resolveStructuredStep({ step: 1 })).toBe(0);
    expect(resolveStructuredStep({ step: 2 })).toBe(1);
  });

  it('should return -1 for step 0 (1-indexed, so 0 is invalid)', () => {
    expect(resolveStructuredStep({ step: 0 })).toBe(-1);
  });

  it('should return -1 for non-object values', () => {
    expect(resolveStructuredStep('foo')).toBe(-1);
    expect(resolveStructuredStep(42)).toBe(-1);
    expect(resolveStructuredStep(null)).toBe(-1);
    expect(resolveStructuredStep([])).toBe(-1);
  });

  it('should return -1 when step property is not a number', () => {
    expect(resolveStructuredStep({ step: 'two' })).toBe(-1);
    expect(resolveStructuredStep({ step: null })).toBe(-1);
  });
});
