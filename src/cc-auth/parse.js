const FIELDS = ['apiKey', 'state', 'userId', 'userName', 'keyName', 'error', 'error_description'];

function readParams(params) {
  for (const field of FIELDS) {
    if (params.getAll(field).length > 1) throw new Error('回调内容包含重复字段，请重新复制完整请求');
  }
  return Object.fromEntries(params);
}

function readBody(text) {
  if (text.trim().startsWith('{')) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* report a fixed error without including credentials */ }
    throw new Error('JSON 格式不正确，请复制完整授权结果');
  }
  return readParams(new URLSearchParams(text));
}

// 只拆分浏览器复制的 cURL 文本，不执行命令、变量、重定向或命令替换。
// 支持 Chrome/Edge 的 Copy as cURL (bash / cmd) 引号及换行形式。
function curlTokens(text) {
  const tokens = [];
  let token = '', quote = '', started = false;
  const flush = () => {
    if (started) tokens.push(token);
    token = '';
    started = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if ((char === '\\' || char === '^') && (next === '\n' || next === '\r') && quote !== "'") {
      index += next === '\r' && text[index + 2] === '\n' ? 2 : 1;
      continue;
    }
    if (quote === "'" || quote === 'ansi') {
      if (char === "'") { quote = ''; continue; }
      if (quote === 'ansi' && char === '\\') {
        const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
        if (next in escapes) { token += escapes[next]; index++; continue; }
        if (next === 'x' || next === 'u') {
          const length = next === 'x' ? 2 : 4;
          const hex = text.slice(index + 2, index + 2 + length);
          if (hex.length === length && /^[a-f\d]+$/i.test(hex)) {
            token += String.fromCharCode(parseInt(hex, 16));
            index += length + 1;
            continue;
          }
        }
      }
      token += char;
      continue;
    }
    if (char === '^' && next && (quote === '"' || !quote)) {
      if (next === '"') {
        quote = quote === '"' ? '' : '"';
        started = true;
        index++;
        continue;
      }
      token += next;
      index++;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = ''; continue; }
      if (char === '\\' && ['"', '\\', '$', '`'].includes(next)) {
        token += next;
        index++;
      } else token += char;
      continue;
    }
    if (/\s/.test(char)) { flush(); continue; }
    started = true;
    if (char === '$' && next === "'") { quote = 'ansi'; index++; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '\\' && next) { token += next; index++; continue; }
    token += char;
  }
  if (quote) throw new Error('cURL 内容不完整，请重新复制完整请求');
  flush();
  return tokens;
}

function readCurl(text) {
  const tokens = curlTokens(text);
  const parts = [];
  let callbackUrl;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const dataOption = token.match(/^(--data(?:-raw|-binary|-urlencode)?|-d)(?:=(.*))?$/s);
    if (dataOption) {
      const value = dataOption[2] ?? tokens[++index];
      if (value === undefined || value.startsWith('@')) throw new Error('请粘贴包含实际请求体的 cURL，不支持文件引用');
      if (dataOption[1] === '--data-urlencode') {
        const separator = value.indexOf('=');
        if (separator <= 0) throw new Error('请复制包含字段名称和实际内容的回调请求');
        parts.push(value.slice(0, separator + 1) + encodeURIComponent(value.slice(separator + 1)));
      } else parts.push(value);
    } else if (['-H', '--header', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer', '-X', '--request'].includes(token)) {
      // 请求头、Cookie 和 Referer 不属于回调正文，也不能覆盖目标地址。
      index++;
    } else if (token === '--url') {
      callbackUrl = tokens[++index];
    } else if (token.startsWith('--url=')) {
      callbackUrl = token.slice(6);
    } else if (/^https?:\/\//i.test(token)) {
      callbackUrl = token;
    }
  }
  if (!parts.length) throw new Error('cURL 中没有回调请求体，请复制发往 localhost 的 POST 请求');
  if (!callbackUrl) throw new Error('cURL 中没有回调地址，请重新复制完整请求');
  return { body: readBody(parts.join('&')), callbackUrl };
}

export function parseCcAuthPaste(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('请粘贴授权回调内容');
  if (Buffer.byteLength(input, 'utf8') > 64_000) throw new Error('回调内容过长，请仅复制授权回调请求');
  const text = input.trim();
  let result;
  if (/^curl(?:\.exe)?\s/i.test(text)) result = readCurl(text);
  else if (/^https?:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); }
    catch { throw new Error('回调 URL 格式不正确'); }
    const params = new URLSearchParams(url.search);
    for (const [key, value] of new URLSearchParams(url.hash.slice(1))) params.append(key, value);
    result = { body: readParams(params), callbackUrl: url.toString() };
  } else result = { body: readBody(text) };

  if (!result.body.apiKey && !result.body.error) {
    throw new Error('内容中没有 apiKey。只有 state 的 localhost 地址无法提取 Key，请在浏览器 Network 中复制 POST 请求（Copy as cURL）');
  }
  return result;
}

export function matchesCcCallbackUrl(value, expected) {
  try {
    const actual = new URL(value);
    const target = new URL(expected);
    return actual.origin === target.origin && actual.pathname === target.pathname && !actual.username && !actual.password;
  } catch { return false; }
}
