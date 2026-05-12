/**
 * Parse an Apple XML plist document into plain JavaScript values.
 *
 * Supported value types:
 *
 * - `dict`
 * - `array`
 * - `string`
 * - `integer`
 * - `real`
 * - `true` / `false`
 * - `date`
 * - `data`
 *
 * `data` payloads are returned as normalized base64 strings so the result stays
 * JSON-serializable and dependency-free.
 *
 * @param {string} xml XML plist string.
 * @returns {unknown} Parsed plist value.
 */
export function parsePlist(xml) {
  const state = {
    index: 0,
    tokens: tokenizePlist(xml),
  };

  skipIgnorableTokens(state);

  if (!/^<plist(?:\s+[^>]*)?>$/u.test(state.tokens[state.index] ?? "")) {
    throw new Error("Invalid plist: missing <plist> root element");
  }
  state.index += 1;

  const value = parseValue(state);

  skipIgnorableTokens(state);
  if (state.tokens[state.index] !== "</plist>") {
    throw new Error("Invalid plist: missing </plist> closing tag");
  }
  state.index += 1;

  skipIgnorableTokens(state);
  if (state.index !== state.tokens.length) {
    throw new Error("Invalid plist: trailing content after </plist>");
  }

  return value;
}

/**
 * Normalize and parse a plist that is expected to be a dictionary.
 *
 * @param {string} xml XML plist string.
 * @returns {Record<string, unknown>} Parsed dictionary.
 */
export function parsePlistDict(xml) {
  const value = parsePlist(xml);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected plist root dictionary");
  }

  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Normalize and parse a plist that is expected to be an array.
 *
 * @param {string} xml XML plist string.
 * @returns {unknown[]} Parsed array.
 */
export function parsePlistArray(xml) {
  const value = parsePlist(xml);

  if (!Array.isArray(value)) {
    throw new Error("Expected plist root array");
  }

  return value;
}

/**
 * Parse a plist value at the current parser position.
 *
 * @param {{ index: number, tokens: string[] }} state Parser state.
 * @returns {unknown} Parsed value.
 */
function parseValue(state) {
  skipIgnorableTokens(state);

  const token = state.tokens[state.index];

  if (!token) {
    throw new Error("Invalid plist: unexpected end of input");
  }

  if (token === "<dict>") {
    state.index += 1;
    return parseDict(state);
  }
  if (token === "<dict/>") {
    state.index += 1;
    return {};
  }
  if (token === "<array>") {
    state.index += 1;
    return parseArray(state);
  }
  if (token === "<array/>") {
    state.index += 1;
    return [];
  }
  if (token === "<true/>") {
    state.index += 1;
    return true;
  }
  if (token === "<false/>") {
    state.index += 1;
    return false;
  }

  const scalarTag = token.match(/^<(string|integer|real|date|data)>$/u)?.[1];

  if (scalarTag) {
    state.index += 1;
    const text = collectTextUntil(state, `</${scalarTag}>`);
    state.index += 1;
    return parseScalarValue(scalarTag, text);
  }

  throw new Error(`Invalid plist: unsupported token ${token}`);
}

/**
 * Parse a `<dict>` value.
 *
 * @param {{ index: number, tokens: string[] }} state Parser state.
 * @returns {Record<string, unknown>} Parsed dictionary.
 */
function parseDict(state) {
  const result = {};

  while (state.index < state.tokens.length) {
    skipIgnorableTokens(state);

    if (state.tokens[state.index] === "</dict>") {
      state.index += 1;
      return result;
    }

    if (state.tokens[state.index] !== "<key>") {
      throw new Error(
        `Invalid plist dict: expected <key> but found ${state.tokens[state.index]}`,
      );
    }

    state.index += 1;
    const key = decodeXmlEntities(collectTextUntil(state, "</key>").trim());
    state.index += 1;

    result[key] = parseValue(state);
  }

  throw new Error("Invalid plist dict: missing </dict>");
}

/**
 * Parse an `<array>` value.
 *
 * @param {{ index: number, tokens: string[] }} state Parser state.
 * @returns {unknown[]} Parsed array.
 */
function parseArray(state) {
  const result = [];

  while (state.index < state.tokens.length) {
    skipIgnorableTokens(state);

    if (state.tokens[state.index] === "</array>") {
      state.index += 1;
      return result;
    }

    result.push(parseValue(state));
  }

  throw new Error("Invalid plist array: missing </array>");
}

/**
 * Read text content until the closing tag is reached.
 *
 * @param {{ index: number, tokens: string[] }} state Parser state.
 * @param {string} closingTag Closing tag.
 * @returns {string} Collected text.
 */
function collectTextUntil(state, closingTag) {
  let value = "";

  while (
    state.index < state.tokens.length &&
    state.tokens[state.index] !== closingTag
  ) {
    value += state.tokens[state.index];
    state.index += 1;
  }

  if (state.tokens[state.index] !== closingTag) {
    throw new Error(`Invalid plist: missing ${closingTag}`);
  }

  return value;
}

/**
 * Parse a scalar plist value.
 *
 * @param {string} tag Scalar tag name.
 * @param {string} value Raw text value.
 * @returns {string | number} Parsed value.
 */
function parseScalarValue(tag, value) {
  const decoded = decodeXmlEntities(value);

  if (tag === "integer") {
    return Number.parseInt(decoded.trim(), 10);
  }
  if (tag === "real") {
    return Number.parseFloat(decoded.trim());
  }
  if (tag === "data") {
    return decoded.replace(/\s+/gu, "");
  }

  return decoded.trim();
}

/**
 * Tokenize a plist XML string.
 *
 * @param {string} xml XML input.
 * @returns {string[]} Tokens.
 */
function tokenizePlist(xml) {
  const normalized = xml
    .replace(/\r\n?/gu, "\n")
    .replace(/<!--([\s\S]*?)-->/gu, "")
    .trim();

  return normalized.match(/<[^>]+>|[^<]+/gu) ?? [];
}

/**
 * Decode the XML entities commonly used in plist payloads.
 *
 * @param {string} value Encoded text.
 * @returns {string} Decoded text.
 */
function decodeXmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

/**
 * Skip whitespace and ignorable declaration tokens.
 *
 * @param {{ index: number, tokens: string[] }} state Parser state.
 */
function skipIgnorableTokens(state) {
  while (state.index < state.tokens.length) {
    const token = state.tokens[state.index];

    if (token === undefined) {
      return;
    }
    if (token.trim() === "") {
      state.index += 1;
      continue;
    }
    if (isXmlDeclaration(token) || isDoctype(token) || isComment(token)) {
      state.index += 1;
      continue;
    }
    return;
  }
}

/**
 * Test whether the token is an XML declaration.
 *
 * @param {string | undefined} token Candidate token.
 * @returns {boolean} True when the token is an XML declaration.
 */
function isXmlDeclaration(token) {
  return token?.startsWith("<?xml") ?? false;
}

/**
 * Test whether the token is a doctype declaration.
 *
 * @param {string | undefined} token Candidate token.
 * @returns {boolean} True when the token is a doctype declaration.
 */
function isDoctype(token) {
  return token?.startsWith("<!DOCTYPE") ?? false;
}

/**
 * Test whether the token is a comment.
 *
 * @param {string | undefined} token Candidate token.
 * @returns {boolean} True when the token is a comment token.
 */
function isComment(token) {
  return token?.startsWith("<!--") ?? false;
}
