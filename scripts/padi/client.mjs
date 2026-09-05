const PADI_AUTH_BASE_URL = "https://api.global-prod.padi.com";
const PADI_LOGBOOK_BASE_URL = "https://logbook.global-prod.padi.com";

// Public OAuth client id -- not a secret, per the scratch reference file's own note.
export const PADI_CLIENT_ID = "7l7c6rgndimr802cfhva7akdsh";

const LOGBOOK_PAGE_QUERY = `query logbook_logs($affiliate_id: Int!, $limit: Int, $offset: Int) {
  logbook_logs(
    where: {affiliate_id: {_eq: $affiliate_id}}
    order_by: {dive_date: desc, id: desc}
    limit: $limit
    offset: $offset
  ) {
    id
    log_type
    log_course
    log_number
    dive_title
    dive_date
    dive_location
    status
  }
}`;

const LOGBOOK_DETAIL_QUERY = `query logbook_logs($affiliate_id: Int!, $id: Int!) {
  logbook_logs(
    where: {affiliate_id: {_eq: $affiliate_id}, _and: {id: {_eq: $id}}}
  ) {
    id
    log_type
    log_course
    log_number
    dive_type
    dive_title
    dive_date
    dive_location
    memsys_member_number
    status
    adventure_dive
    depth_times {
      max_depth
      bottom_time
      time_in
      time_out
    }
    skills {
      dive_skills
    }
    conditions {
      water_type
      body_of_water
      weather
      air_temp
      surface_water_temp
      bottom_water_temp
      visibility
      visibility_distance
      wave_condition
      current
      surge
    }
    equipment {
      suit_type
      weight
      weight_type
      additional_equipment
      cylinder_type
      cylinder_size
      gas_mixture
      oxygen
      nitrogen
      helium
      starting_pressure
      ending_pressure
    }
    experiences {
      feeling
      notes
      buddies
      dive_center
    }
  }
}`;

/**
 * Thrown for any failure talking to PADI's API -- network error, non-2xx
 * response, or a malformed response body. `message` is always a generic,
 * status-only description: it must never echo the original request body,
 * since the login request body contains the caller's plaintext password.
 */
export class PadiApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PadiApiError";
    this.status = status;
  }
}

async function padiRequest(url, { headers, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PadiApiError("PADI request failed: network error", undefined);
  }

  if (!response.ok) {
    throw new PadiApiError(`PADI request failed with status ${response.status}`, response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new PadiApiError(
      `PADI request failed: invalid response body (status ${response.status})`,
      response.status,
    );
  }
}

/**
 * Logs in with a PADI username/password. Returns the parsed
 * `{tokens: {idToken, accessToken, refreshToken, tokenType, expiresIn}}` response.
 * The password is used only to build this one request and is never included
 * in a thrown error.
 */
export async function login(username, password) {
  return padiRequest(`${PADI_AUTH_BASE_URL}/auth/api/oauth/login`, {
    body: { username, password, clientId: PADI_CLIENT_ID },
  });
}

/**
 * Refreshes a PADI token set. Returns the same `{tokens: {...}}` shape as `login`.
 */
export async function refresh(refreshToken, idToken) {
  return padiRequest(`${PADI_AUTH_BASE_URL}/auth/api/oauth/refresh`, {
    body: { refreshToken, clientId: PADI_CLIENT_ID, idToken },
  });
}

/**
 * Fetches one page of the logbook's dive list. `affiliateId` is set as both the
 * `affiliate-id` HTTP header and the `affiliate_id` GraphQL variable -- PADI's
 * captured requests set both to the same value on every logbook call, alongside
 * `x-platform: web`.
 */
export async function fetchLogbookPage(accessToken, affiliateId, { limit, offset } = {}) {
  return padiRequest(`${PADI_LOGBOOK_BASE_URL}/api/Logbook`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-platform": "web",
      "affiliate-id": String(affiliateId),
    },
    body: {
      query: LOGBOOK_PAGE_QUERY,
      variables: { affiliate_id: String(affiliateId), limit, offset },
    },
  });
}

/**
 * Fetches the full detail record for a single logbook dive id.
 */
export async function fetchLogbookDetail(accessToken, affiliateId, id) {
  return padiRequest(`${PADI_LOGBOOK_BASE_URL}/api/Logbook`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-platform": "web",
      "affiliate-id": String(affiliateId),
    },
    body: {
      query: LOGBOOK_DETAIL_QUERY,
      variables: { affiliate_id: String(affiliateId), id: String(id) },
    },
  });
}

/**
 * Decodes the claims out of a PADI idToken JWT WITHOUT verifying its signature.
 * This is intentional and safe: the idToken came directly from PADI's own
 * login/refresh response over TLS in response to our own request -- we are
 * reading a claim off our own server-to-server response, not making an
 * authorization decision based on a token supplied by an untrusted client.
 *
 * The affiliate id claim is literally named `custom:affiliate_id` (a string),
 * not `affiliate_id` -- that name is reserved for the separate GraphQL
 * variable / HTTP header used by the logbook calls above.
 */
export function decodeIdTokenClaims(idToken) {
  const parts = String(idToken).split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed PADI idToken: expected a 3-part JWT");
  }

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

  return { affiliateId: payload["custom:affiliate_id"] };
}
