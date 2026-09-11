const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFeatureRequest } = require('../src/prompts');
const { CodexProvider } = require('../src/codex-provider');

// Opt-in subscription eval. Synthetic problem only; no user data or screenshots.
test('live suggestion returns a fenced implementation for a coding problem', { skip: !process.env.CUE_LIVE_EVAL, timeout: 120000 }, async () => {
  const request = buildFeatureRequest('say', { transcript: [{ channel: 'them', text: 'LeetCode practice: Given an array of digits, return all unique three-digit even numbers formed using three distinct array indices. No leading zeros; return sorted ascending. Python3 signature: class Solution: def findEvenNumbers(self, digits: List[int]) -> List[int]. Example [2,1,3,0] gives [102,120,130,132,210,230,302,310,312,320].' }], screenIncluded: false });
  const text = await new CodexProvider().stream({ system: request.system, turns: [{ role: 'user', text: request.text }] });
  const code = text.match(/```(?:python|python3)?\s*\n([\s\S]*?)```/i)?.[1];
  assert.ok(code, 'Expected fenced Python code, not just narration. Response: ' + text);
  assert.match(code, /def findEvenNumbers/);
  assert.match(text, /O\(/);
});

test('live coding question respects hints-only intent', { skip: !process.env.CUE_LIVE_EVAL, timeout: 120000 }, async () => {
  const request = buildFeatureRequest('ask', { userText: 'LeetCode Two Sum: return two indices whose values add to target. Give only one hint, no code and no complete solution.', screenIncluded: false });
  const text = await new CodexProvider().stream({ system: request.system, turns: [{ role: 'user', text: request.text }] });
  assert.ok(text.trim());
  assert.doesNotMatch(text, /```|def twoSum|class Solution/);
});
