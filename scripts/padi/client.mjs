const PADI_AUTH_BASE_URL = "https://api.global-prod.padi.com";
const PADI_LOGBOOK_BASE_URL = "https://logbook.global-prod.padi.com";

// Public OAuth client id -- not a secret, per the scratch reference file's own note.
export const PADI_CLIENT_ID = "7l7c6rgndimr802cfhva7akdsh";

export const LOGBOOK_PAGE_QUERY = `query logbook_logs($affiliate_id: Int!, $limit: Int, $offset: Int) {
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

const CREATE_LOGBOOK_DIVE_MUTATION = `mutation insert_logbook_logs($general: [logbook_logs_insert_input!]!) {
  insert_logbook_logs(objects: $general) {
    affected_rows
    returning {
      id
      affiliate_id
      dive_title
      dive_type
      dive_location
      log_type
      log_course
      dive_date
      created_date
      status
      adventure_dive
    }
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
 *
 * `bearerToken` must be the **idToken**, not the OAuth accessToken returned alongside it --
 * the logbook API validates the JWT's own `custom:affiliate_id` claim against the `affiliate-id`
 * header/variable, and only the idToken carries that claim. Sending the accessToken here gets a
 * 403 "affiliateid and idtoken don't match" (see scripts/padi/debug-logbook.mjs).
 */
export async function fetchLogbookPage(bearerToken, affiliateId, { limit, offset } = {}) {
  return padiRequest(`${PADI_LOGBOOK_BASE_URL}/api/Logbook`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
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
 * Fetches the full detail record for a single logbook dive id. `bearerToken` must be the idToken
 * -- see `fetchLogbookPage`'s doc comment above.
 */
export async function fetchLogbookDetail(bearerToken, affiliateId, id) {
  return padiRequest(`${PADI_LOGBOOK_BASE_URL}/api/Logbook`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
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
 * Creates a new PADI logbook dive from this app's local dive fields. `bearerToken` must be the
 * idToken, matching the read-side logbook calls above. PADI's browser request sends the insert
 * object as `variables.general` even though the mutation type is a one-item array; keep that shape
 * for compatibility with the captured request.
 */
export async function createLogbookDive(bearerToken, affiliateId, general) {
  return padiRequest(`${PADI_LOGBOOK_BASE_URL}/api/Logbook`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "x-platform": "web",
      "affiliate-id": String(affiliateId),
    },
    body: {
      query: CREATE_LOGBOOK_DIVE_MUTATION,
      variables: { general },
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
