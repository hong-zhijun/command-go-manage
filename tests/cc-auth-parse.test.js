import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCcAuthPaste, matchesCcCallbackUrl } from '../src/cc-auth/parse.js';

const callback = 'http://localhost:5959/callback';
const payload = { apiKey: 'user_test+plus/=end', state: 'my-state', userId: 'user-id', userName: '授权 账号', keyName: 'cli-test' };
const form = new URLSearchParams(payload).toString();

test('parses callback JSON, encoded form and URLs without losing token characters', () => {
  for (const text of [JSON.stringify(payload), form, `${callback}?${form}`, `${callback}#${form}`]) {
    assert.deepEqual(parseCcAuthPaste(text).body, payload);
  }
});

test('parses browser cURL bash, ANSI-C and Windows quoting', () => {
  const cases = [
    `curl '${callback}' \\\n  -H 'Content-Type: application/x-www-form-urlencoded' \\\n  --data-raw '${form}'`,
    `curl '${callback}' --data-raw $'${form}'`,
    `curl.exe "${callback}" ^\r\n --data-raw "${form}"`,
    `curl ^"${callback}^" ^\r\n --data-raw ^"${form.replaceAll('&', '^&')}^"`,
    `curl --url='${callback}' --data='${form}'`,
    `curl '${callback}' --data-raw '${JSON.stringify(payload)}'`,
    `curl '${callback}' ${Object.entries(payload).map(([key, value]) => `--data-urlencode '${key}=${value}'`).join(' ')}`,
    `curl '${callback}' --referer 'https://commandcode.ai/' -H 'x-decoy: apiKey=wrong' --data-raw '${form}'`,
  ];
  for (const text of cases) {
    const parsed = parseCcAuthPaste(text);
    assert.deepEqual(parsed.body, payload);
    assert.equal(parsed.callbackUrl, callback);
  }
});

test('only reads cURL text; never expands command substitutions or visits URLs', () => {
  const name = '$(exit 1); `exit 2`';
  const text = `curl '${callback}' --data-raw '${new URLSearchParams({ ...payload, userName: name })}'`;
  assert.equal(parseCcAuthPaste(text).body.userName, name);
  const escaped = String.raw`curl 'http://localhost:5959/callback' --data-raw $'{"apiKey":"user_test","state":"my-state","userName":"O\'Neil"}'`;
  assert.equal(parseCcAuthPaste(escaped).body.userName, "O'Neil");
});

test('rejects state-only addresses, malformed payloads, duplicate fields and oversized input', () => {
  for (const text of ['', `${callback}/complete?state=my-state`, 'curl localhost', `curl '${callback}' --data @file`, `curl '${callback}' --data 'unfinished`, '{"apiKey":', form + '&state=another', 'a'.repeat(64001)]) {
    assert.throws(() => parseCcAuthPaste(text));
  }
});

test('requires the exact localhost callback origin and path', () => {
  assert.equal(matchesCcCallbackUrl(`${callback}?${form}`, callback), true);
  for (const value of ['http://localhost:5959/callback/complete', 'http://localhost.evil.test:5959/callback', 'https://example.com/callback', 'http://localhost:3000/callback', 'http://admin@localhost:5959/callback']) {
    assert.equal(matchesCcCallbackUrl(value, callback), false);
  }
});
