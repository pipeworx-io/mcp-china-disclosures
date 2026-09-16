interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * China Disclosures MCP — non-SEC Chinese biotech deals and HK/STAR IPO
 * financing, read straight out of the exchanges' own disclosure feeds. Keyless.
 *
 * Why this exists: china_licensing_deals (china-pharma) and pharma_licensing_deals
 * (pharma-deals) are both SEC-filing-based, so a licensing deal between two
 * companies with NO US-listed party — a China-to-China deal, or China-to-Japan —
 * is structurally invisible to them even though it is publicly disclosed.
 * Demand log, 2026-09-13 scouting pass: 3+ real asks for exactly that class of
 * deal, plus HK/STAR biotech IPO financing.
 *
 * Two disclosure layers close the gap, both keyless, both probed live 2026-09-13:
 *
 *  A/B. HKEXnews title-search (titleSearchServlet.do) — the SAME endpoint
 *       nmpa_drug_approvals (china-pharma) already uses for NMPA approvals, here
 *       pointed at deal and listing vocabulary instead. Catches any deal or IPO
 *       where the Chinese/Asian party is HK-listed, regardless of any US nexus —
 *       e.g. SBP GROUP's "EXCLUSIVE LICENSE AGREEMENT FOR TQB2102 WITH CIPLA"
 *       (an Indian partner, zero US filer).
 *
 *  C.   CNINFO (cninfo.com.cn) — the official disclosure feed for BOTH Shenzhen
 *       and Shanghai A-shares, STAR Market (科创板) included. Covers the other
 *       half of the gap: a deal or IPO with an A-share party and no HK/US nexus
 *       at all. `hisAnnouncement/query` is a POST JSON endpoint, no auth, plain
 *       browser UA — verified live returning 20,703 matches for searchkey=许可
 *       (license/licence), dated as recent as today.
 *
 * Shared trap across BOTH sources, load-bearing: a filter param that LOOKS like
 * it should narrow a search can silently no-op instead of erroring — see the
 * per-source notes below. Every filter claim in this pack was verified by
 * comparing an unfiltered call against a filtered one and confirming the
 * `total`/`recordCnt` actually changed, not just eyeballing a plausible response.
 */


async function pwFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(url, init, 'China Disclosures');
}

const UA = 'pipeworx-mcp/1.0 (bruce@mojibake.ai)';

// ─────────────────────────────────────────────────────────────────────────
// Shared HKEX title-search plumbing (tools A + B)
// ─────────────────────────────────────────────────────────────────────────

const HKEX_TITLE_SEARCH = 'https://www1.hkexnews.hk/search/titleSearchServlet.do';
const HKEX_BASE = 'https://www1.hkexnews.hk';

interface HkexRow {
  NEWS_ID?: string;
  STOCK_NAME?: string;
  STOCK_CODE?: string;
  TITLE?: string;
  SHORT_TEXT?: string;
  DATE_TIME?: string;
  FILE_LINK?: string;
}

/** "28/08/2026 08:00" -> "2026-08-28". Null if the format ever changes. */
function hkexDateToIso(dt: string | undefined): string | null {
  if (!dt) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(dt.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Numeric/named HTML entities HKEXnews titles actually use, decoded so a
 *  quote doesn't come through as `&#x27;` and read as corruption. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '—');
}

/**
 * TRAP, load-bearing (verified 2026-09-13 with three different from/to windows
 * on THREE different title terms — "License Agreement", "Licensing Agreement",
 * "Global Offering" — same result set every time, including a 1990-only window
 * that still returned the identical rows): titleSearchServlet.do with
 * searchType=1 and a non-empty `title` IGNORES `from`/`to` entirely. It is a
 * rolling "most recent title-matching filings" window (typically the last
 * several weeks to a couple of months, depending how common the phrase is),
 * not a date-filtered query. So this pack always fetches the unbounded window
 * per title term and does its OWN date filtering client-side — asking for a
 * period before the window's start returns `found: false` with an explicit
 * hint, never a silently-empty "nothing happened that period".
 */
async function hkexTitleSearch(title: string): Promise<HkexRow[]> {
  const url =
    `${HKEX_TITLE_SEARCH}?sortDir=0&sortByOptions=DateTime&category=0&market=SEHK&searchType=1` +
    `&documentType=-1&t1code=-2&t2Gcode=-2&t2code=-2&stockId=-1&from=19900101&to=99991231` +
    `&title=${encodeURIComponent(title)}&lang=E`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res, 'HKEXnews title search');
  const data = (await res.json()) as { result?: string };
  if (!data.result) return [];
  try {
    return JSON.parse(data.result) as HkexRow[];
  } catch {
    throw new Error('upstream_down: HKEXnews title search returned a non-JSON `result` payload.');
  }
}

/** Fetch several title terms and merge into one de-duplicated, newest-first list. */
async function hkexMergedSearch(titles: string[]): Promise<HkexRow[]> {
  const batches = await Promise.all(titles.map((t) => hkexTitleSearch(t)));
  const seen = new Set<string>();
  const merged: HkexRow[] = [];
  for (const rows of batches) {
    for (const row of rows) {
      const key = row.NEWS_ID ?? `${row.STOCK_CODE}-${row.DATE_TIME}-${row.TITLE}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  merged.sort((a, b) => String(b.DATE_TIME ?? '').localeCompare(String(a.DATE_TIME ?? '')));
  return merged;
}

function reachableWindowNote(rows: HkexRow[]): string {
  if (rows.length === 0) return 'HKEXnews returned no matching filings at all just now.';
  const dates = rows.map((r) => hkexDateToIso(r.DATE_TIME)).filter((d): d is string => !!d).sort();
  const start = dates[0];
  const end = dates[dates.length - 1];
  return (
    `The reachable window right now covers ${start ?? '?'} to ${end ?? '?'} (HKEXnews' title search ` +
    'always returns its own most-recent-N set — see source_note); a window entirely before that start ' +
    'is not reachable through this source at all, which is different from there being no matching deals.'
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tool A: hkex_licensing_deals
// ─────────────────────────────────────────────────────────────────────────

const LICENSING_TITLES = ['License Agreement', 'Licensing Agreement'];

interface LicensingDeal {
  id: string;
  company: string;
  stock_code: string | null;
  headline: string;
  filing_category: string | null;
  filing_date: string;
  filing_url: string | null;
}

function toLicensingDeal(row: HkexRow): LicensingDeal | null {
  const dt = hkexDateToIso(row.DATE_TIME);
  if (!row.TITLE || !dt) return null;
  const title = decodeEntities(row.TITLE).replace(/\s+/g, ' ').trim();
  const nameEn = title.replace(/^(VOLUNTARY ANNOUNCEMENT|INSIDE INFORMATION)\s*[-–—]?\s*/i, '').trim() || title;
  return {
    id: row.NEWS_ID ?? `${row.STOCK_CODE ?? 'x'}-${dt}`,
    company: row.STOCK_NAME?.trim() || 'Unknown',
    stock_code: row.STOCK_CODE?.trim() || null,
    headline: nameEn,
    filing_category: row.SHORT_TEXT ? decodeEntities(row.SHORT_TEXT).replace(/<br\s*\/?>/gi, '').trim() : null,
    filing_date: dt,
    filing_url: row.FILE_LINK ? `${HKEX_BASE}${row.FILE_LINK}` : null,
  };
}

async function hkexLicensingDeals(args: Record<string, unknown>) {
  const now = new Date();
  const until = typeof args.until === 'string' && args.until ? args.until.slice(0, 10) : now.toISOString().slice(0, 10);
  const since =
    typeof args.since === 'string' && args.since
      ? args.since.slice(0, 10)
      : new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const limit = Math.min(40, Math.max(1, (args.limit as number) ?? 15));
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim().toLowerCase() : null;

  const rows = await hkexMergedSearch(LICENSING_TITLES);
  const deals: LicensingDeal[] = [];
  for (const row of rows) {
    const deal = toLicensingDeal(row);
    if (!deal) continue;
    if (deal.filing_date < since || deal.filing_date > until) continue;
    if (query && !deal.headline.toLowerCase().includes(query) && !deal.company.toLowerCase().includes(query)) continue;
    deals.push(deal);
  }

  if (deals.length === 0) {
    return {
      found: false,
      reason: 'no_matching_filings_in_window',
      searched: { since, until, query, hkex_title_terms: LICENSING_TITLES },
      hint: reachableWindowNote(rows),
    };
  }

  return {
    found: true,
    source: 'HKEX (Hong Kong Exchange) listed-company disclosures — titles matching "License Agreement" or "Licensing Agreement"',
    source_note:
      "HKEXnews' title-search endpoint returns a rolling window of the most recent filings matching the title term, not a date-filtered query — `since`/`until` are applied by this pack after fetching, not by HKEX. History older than the current window (recently, roughly the last few weeks) is not reachable through this source.",
    scope_note:
      'Covers deals where the HK-listed party disclosed the agreement under HKEX rules — including deals with NO US or A-share party at all (e.g. a Chinese HKEX-listed biotech licensing a drug to an Indian, Japanese, or European partner). A deal with neither an HKEX-listed nor an SEC-filing party is still invisible to us; for A-share-only deals with no HK nexus, use cninfo_disclosure_search instead. Not every hit is a NEW deal — amendment and business-update announcements about a prior deal also carry these titles, and are included as-is under `filing_category`.',
    searched: { since, until, query, hkex_title_terms: LICENSING_TITLES },
    count: deals.length,
    deals: deals.slice(0, limit),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool B: hkex_ipo_filings
// ─────────────────────────────────────────────────────────────────────────

interface IpoFiling {
  id: string;
  company: string;
  stock_code: string | null;
  doc_category: string | null;
  filing_date: string;
  filing_url: string | null;
  file_size: string | null;
}

function toIpoFiling(row: HkexRow): IpoFiling | null {
  const dt = hkexDateToIso(row.DATE_TIME);
  if (!dt) return null;
  return {
    id: row.NEWS_ID ?? `${row.STOCK_CODE ?? 'x'}-${dt}`,
    company: row.STOCK_NAME?.trim() || 'Unknown',
    stock_code: row.STOCK_CODE?.trim() || null,
    doc_category: row.SHORT_TEXT ? decodeEntities(row.SHORT_TEXT).replace(/<br\s*\/?>/gi, '').trim() : null,
    filing_date: dt,
    filing_url: row.FILE_LINK ? `${HKEX_BASE}${row.FILE_LINK}` : null,
    file_size: null,
  };
}

async function hkexIpoFilings(args: Record<string, unknown>) {
  const now = new Date();
  const until = typeof args.until === 'string' && args.until ? args.until.slice(0, 10) : now.toISOString().slice(0, 10);
  const since =
    typeof args.since === 'string' && args.since
      ? args.since.slice(0, 10)
      : new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const limit = Math.min(40, Math.max(1, (args.limit as number) ?? 15));
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim().toLowerCase() : null;

  const rows = await hkexTitleSearch('Global Offering');
  const filings: IpoFiling[] = [];
  for (const row of rows) {
    const f = toIpoFiling(row);
    if (!f) continue;
    if (f.filing_date < since || f.filing_date > until) continue;
    if (query && !f.company.toLowerCase().includes(query)) continue;
    filings.push(f);
  }

  if (filings.length === 0) {
    return {
      found: false,
      reason: 'no_matching_filings_in_window',
      searched: { since, until, query },
      hint: reachableWindowNote(rows),
    };
  }

  return {
    found: true,
    source: 'HKEX (Hong Kong Exchange) listing documents — titles matching "Global Offering"',
    source_note:
      "HKEXnews' title-search endpoint returns a rolling window of the most recent filings matching the title, not a date-filtered query — `since`/`until` are applied by this pack after fetching. A company listing more than a few weeks/months ago is not reachable through this source; use the company's own investor-relations page for older IPOs.",
    scope_note:
      'Every HK IPO files a "GLOBAL OFFERING" title — NOT biotech-specific. Each listing typically produces two rows: a "Listing Documents" entry (the prospectus PDF, often tens of MB) and an "Announcements and Notices" formal-notice entry for the same event — both are returned, distinguished by `doc_category`. Filter to biotech/pharma with `query` (a company-name keyword) since this source carries no industry field. Covers HKEX Main Board and GEM only — an A-share/STAR Market (科创板) IPO is a different exchange and will not appear here; use cninfo_disclosure_search with searchkey="招股说明书" for that.',
    searched: { since, until, query },
    count: filings.length,
    filings: filings.slice(0, limit),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool C: cninfo_disclosure_search
// ─────────────────────────────────────────────────────────────────────────

const CNINFO_QUERY = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const CNINFO_REFERER = 'https://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice';

/**
 * Board/segment codes for the `board` filter, read out of the search page's OWN
 * network calls (the china-exchange-data recipe) rather than guessed — a
 * category=/plate=kcb guess was silently ignored in the initial probe (200 OK,
 * unfiltered results, no error) and would have shipped as a broken filter.
 * Verified live 2026-09-13 by selecting each checkbox in the site's own UI and
 * reading the resulting `plate` value off the real POST body, then confirming
 * `totalAnnouncement` actually changes: unfiltered searchkey=许可 returns
 * 20,703; plate=shkcp (STAR Market only) returns 306, every row a 688xxx code.
 * Only codes actually observed this way are listed — a guessed code for a
 * board nobody has verified is worse than no filter at all.
 */
const CNINFO_BOARDS: Record<string, string> = {
  star: 'shkcp', // 科创板 STAR Market (SSE) — all results are 688xxx codes
  chinext: 'szcy', // 创业板 ChiNext (SZSE)
};

interface CninfoRow {
  secCode?: string;
  secName?: string;
  announcementId?: string;
  announcementTitle?: string;
  announcementTime?: number;
  adjunctUrl?: string;
  pageColumn?: string;
}

function stripHighlightTags(s: string): string {
  return s.replace(/<\/?em>/g, '');
}

async function cninfoQuery(searchkey: string, plate: string, seDate: string, pageSize: number) {
  const params = new URLSearchParams({
    pageNum: '1',
    pageSize: String(pageSize),
    column: 'szse',
    tabName: 'fulltext',
    plate,
    stock: '',
    searchkey,
    secid: '',
    category: '',
    trade: '',
    seDate,
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  });
  const res = await pwFetch(CNINFO_QUERY, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: CNINFO_REFERER,
      Accept: 'application/json',
    },
    body: params.toString(),
  });
  if (!res.ok) throw await httpError(res, 'CNINFO disclosure search');
  return (await res.json()) as { totalAnnouncement?: number; announcements?: CninfoRow[] | null };
}

async function cninfoDisclosureSearch(args: Record<string, unknown>) {
  const searchkey = typeof args.query === 'string' ? args.query.trim() : '';
  if (!searchkey) {
    throw new Error('user_error: `query` is required — a Chinese-language search term, e.g. "许可" (license) or "招股说明书" (prospectus).');
  }
  const boardArg = typeof args.board === 'string' && args.board.trim() ? args.board.trim().toLowerCase() : null;
  if (boardArg && !CNINFO_BOARDS[boardArg]) {
    throw new Error(`user_error: unknown board "${boardArg}". Valid: ${Object.keys(CNINFO_BOARDS).join(', ')}, or omit for all boards.`);
  }
  const plate = boardArg ? CNINFO_BOARDS[boardArg] : '';
  const now = new Date().toISOString().slice(0, 10);
  const since = typeof args.since === 'string' && args.since ? args.since.slice(0, 10) : null;
  const until = typeof args.until === 'string' && args.until ? args.until.slice(0, 10) : now;
  const seDate = since ? `${since}~${until}` : '';
  const limit = Math.min(40, Math.max(1, (args.limit as number) ?? 15));

  const data = await cninfoQuery(searchkey, plate, seDate, limit);
  const rows = data.announcements ?? [];
  const total = data.totalAnnouncement ?? 0;

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_matching_disclosures',
      searched: { query: searchkey, board: boardArg, since, until },
      total_matched: total,
      hint: boardArg
        ? `No disclosures for "${searchkey}" on ${boardArg} (plate=${plate}) in this window. Try omitting \`board\` to search all of SZSE+SSE, or widen the date range.`
        : `No disclosures matched "${searchkey}" in this window. CNINFO full-text search is exact-substring on the Chinese term — try a shorter or more common phrasing.`,
    };
  }

  const disclosures = rows.map((r) => ({
    company: r.secName ?? null,
    stock_code: r.secCode ?? null,
    title: r.announcementTitle ? stripHighlightTags(r.announcementTitle) : null,
    date: r.announcementTime ? new Date(r.announcementTime).toISOString().slice(0, 10) : null,
    pdf_url: r.adjunctUrl ? `https://static.cninfo.com.cn/${r.adjunctUrl}` : null,
  }));

  return {
    found: true,
    source: 'CNINFO (cninfo.com.cn) — official disclosure feed for SZSE + SSE A-shares, including STAR Market (科创板)',
    scope_note:
      'Covers any A-share-listed company (Shenzhen or Shanghai, including STAR Market) with zero HK/US nexus required — the exact gap hkex_licensing_deals and hkex_ipo_filings cannot reach. A company listed ONLY overseas (no A-share ticker) will not appear here. Search terms are Chinese; do not translate an English query and search that — search the Chinese term directly (e.g. "许可" for licensing/approval, "招股说明书" for an IPO prospectus).',
    board_note: boardArg
      ? `Filtered to ${boardArg} (plate=${plate}) — verified live, this genuinely narrows the result set (see pack README for the unfiltered-vs-filtered comparison), unlike the category/plate guesses that were silently ignored in this endpoint's initial probe.`
      : 'No board filter applied — results span all SZSE+SSE boards. Pass `board` ("star" or "chinext") to narrow; other segments have not been verified against this endpoint and are deliberately not offered as options.',
    searched: { query: searchkey, board: boardArg, since, until },
    total_matched: total,
    returned: disclosures.length,
    disclosures,
  };
}

// ─────────────────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'hkex_licensing_deals',
    description:
      'Biotech/pharma licensing and collaboration deals disclosed by Hong Kong Exchange (HKEX)-listed companies — covers deals with NO US-listed party at all (e.g. a Chinese HKEX-listed biotech out-licensing a drug to an Indian, Japanese or European partner), which SEC-filing-based tools (china_licensing_deals, pharma_licensing_deals) structurally cannot see. Answers "China-to-Japan biotech licensing deals", "recent Asia pharma out-licensing deals not filed with the SEC", "HKEX biotech collaboration agreements". Sourced from HKEXnews disclosure filings whose title contains "License Agreement" or "Licensing Agreement". Returns the company, stock code, headline, filing category and date, and the filing PDF. Coverage requires the Chinese/Asian party to be HKEX-listed — a private-to-private deal with no HK, US or A-share party is invisible to every tool in this catalog.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Filter to filings whose headline or company name contains this text (a drug code, company name, or partner name).' },
        since: { type: 'string', description: 'Earliest filing date, YYYY-MM-DD. Defaults to 90 days ago. Only the current rolling HKEXnews window is reachable — see source_note in the response.' },
        until: { type: 'string', description: 'Latest filing date, YYYY-MM-DD. Defaults to today.' },
        limit: { type: 'number', description: 'Maximum deals to return, 1-40 (default 15).' },
      },
    },
  },
  {
    name: 'hkex_ipo_filings',
    description:
      'Hong Kong IPO / listing financing filings — the Global Offering prospectus and formal notice every company files with HKEX when it goes public or completes a placement. Answers "recent HK IPOs", "HKEX biotech IPO financing", "which companies just listed on the Hong Kong Stock Exchange", "STAR/HK biotech listing documents". Sourced from HKEXnews disclosure filings titled "GLOBAL OFFERING" — covers every industry, not biotech-specific, so filter with `query` (a company name) to find a particular listing. Returns the company, stock code, document category (Listing Documents = the prospectus PDF, or Announcements and Notices = the formal notice for the same event), filing date and PDF link. HKEX Main Board / GEM only — an A-share STAR Market (科创板) IPO is a different exchange, see cninfo_disclosure_search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Filter to filings whose company name contains this text (e.g. "BIO", "PHARMA", or a specific company).' },
        since: { type: 'string', description: 'Earliest filing date, YYYY-MM-DD. Defaults to 90 days ago. Only the current rolling HKEXnews window is reachable — see source_note in the response.' },
        until: { type: 'string', description: 'Latest filing date, YYYY-MM-DD. Defaults to today.' },
        limit: { type: 'number', description: 'Maximum filings to return, 1-40 (default 15).' },
      },
    },
  },
  {
    name: 'cninfo_disclosure_search',
    description:
      'Full-text search over CNINFO (cninfo.com.cn), the official disclosure feed for BOTH Chinese A-share exchanges — Shenzhen (SZSE) and Shanghai (SSE), STAR Market (科创板) included. Covers A-share-listed companies with zero HK or US nexus — the deals and IPOs invisible to every SEC- or HKEX-based tool in this catalog (a China-to-China licensing deal, or a STAR Market IPO prospectus). Answers "A股许可协议公告" (A-share licensing announcements), "STAR Market IPO prospectus filings", "科创板 招股说明书". Search terms must be Chinese (e.g. "许可" for licensing/approval disclosures, "招股说明书" for IPO prospectuses) — do not translate an English query and search that. Optionally filter to one verified board segment (`board`). Returns company, stock code, title, date and PDF link, plus the true total match count.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Chinese-language search term, e.g. "许可" (license/licensing) or "招股说明书" (IPO prospectus). Required.' },
        board: { type: 'string', enum: ['star', 'chinext'], description: 'Restrict to one verified board segment: "star" = STAR Market (科创板, SSE, all 688xxx codes) or "chinext" = ChiNext (创业板, SZSE). Omit to search all SZSE+SSE boards.' },
        since: { type: 'string', description: 'Earliest disclosure date, YYYY-MM-DD. Omitted, no lower bound (server-side date filter, genuinely narrows results).' },
        until: { type: 'string', description: 'Latest disclosure date, YYYY-MM-DD. Defaults to today. Only applied when `since` is also set.' },
        limit: { type: 'number', description: 'Maximum disclosures to return, 1-40 (default 15).' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'hkex_licensing_deals':
      return hkexLicensingDeals(args);
    case 'hkex_ipo_filings':
      return hkexIpoFilings(args);
    case 'cninfo_disclosure_search':
      return cninfoDisclosureSearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
