// Headers observed on an Aperture request to this host with Caller identity enabled.
// Aperture's connector UI forwards the caller in these three headers.
// The captured request had a login and a display name, and no group field.
const USER_LOGIN = "tailscale-user-login";
const USER_NAME = "tailscale-user-name";
const USER_PROFILE_PIC = "tailscale-user-profile-pic";

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value == null ? "" : String(value);
}

// Tailscale encodes non-ASCII identity header values as RFC 2047 Q-encoding.
export function decodeRfc2047(value) {
  const text = String(value ?? "").trim();
  const match = /^=\?([^?]+)\?([bqBQ])\?([\s\S]*)\?=$/.exec(text);
  if (!match) return text;
  const [, charset, encoding, encoded] = match;
  if (!/^utf-8$/i.test(charset)) return text;
  if (encoding.toLowerCase() === "b") {
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  const bytes = [];
  const normalized = encoded.replace(/_/g, " ");
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function callerFromHeaders(headers) {
  const login = decodeRfc2047(headerValue(headers, USER_LOGIN)).trim();
  const name = decodeRfc2047(headerValue(headers, USER_NAME)).trim();
  const profilePic = headerValue(headers, USER_PROFILE_PIC).trim();
  return {
    login: login || null,
    name: name || null,
    profilePic: profilePic || null,
    // No group header was present on the Aperture request.
    groups: [],
  };
}
